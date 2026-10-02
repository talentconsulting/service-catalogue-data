import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildPostmanCollection, buildPostmanEnvironment } from './postman.mjs';

const appDir = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(appDir, 'public');
const dataDir = resolve(process.env.CATALOGUE_DATA_DIR || join(appDir, '..'));
const port = Number(process.env.PORT || 8080);
// The catalogue is rebuilt from disk at most this often; data only changes when the repo is pulled.
const catalogCacheMs = Number(process.env.CATALOG_CACHE_MS ?? 15000);

// Basic Auth is opt-in: set AUTH_PASSWORD (e.g. in a local, gitignored .env file — never commit
// it) to require credentials for every request. With no password configured the server stays
// open, matching today's default so existing setups aren't broken by this change.
const authUser = process.env.AUTH_USERNAME || 'admin';
const authPassword = process.env.AUTH_PASSWORD || '';

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on mismatched lengths, so pad first — the length check itself
  // being fast isn't a meaningful leak for a username/password pair.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function isAuthorized(request) {
  if (!authPassword) return true;
  const header = request.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) return false;
  const user = decoded.slice(0, separatorIndex);
  const pass = decoded.slice(separatorIndex + 1);
  return safeEqual(user, authUser) && safeEqual(pass, authPassword);
}

function requireAuth(response) {
  response.writeHead(401, {
    'content-type': 'text/plain; charset=utf-8',
    'www-authenticate': 'Basic realm="Service catalogue", charset="UTF-8"'
  });
  response.end('Authentication required');
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  const headers = { 'content-type': mimeTypes['.json'], 'cache-control': 'no-store', vary: 'accept-encoding' };
  // The aggregate endpoints return a few MB of JSON that compresses ~30x.
  if (body.length > 1024 && /\bgzip\b/.test(response.req?.headers['accept-encoding'] || '')) {
    response.writeHead(status, { ...headers, 'content-encoding': 'gzip' });
    return response.end(gzipSync(body));
  }
  response.writeHead(status, headers);
  response.end(body);
}

function sendDownload(response, filename, value) {
  response.writeHead(200, {
    'content-type': mimeTypes['.json'],
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${filename}"`
  });
  response.end(JSON.stringify(value, null, 2));
}

function repoSlug(repositoryUrl) {
  return repositoryUrl.replace(/\/$/, '').split('/').pop().replace(/\.git$/, '');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// A scan can produce a schema file with no tables (e.g. a web app with no database of its own);
// that isn't worth a Data schema tab.
async function hasTables(path) {
  if (!await exists(path)) return false;
  try {
    return ((await readJson(path)).tables || []).length > 0;
  } catch {
    return false;
  }
}

async function buildCatalog() {
  const manifest = await readJson(join(dataDir, 'manifest.json'));
  return Promise.all(manifest.map(async (entry) => {
    const slug = repoSlug(entry['github-repo']);
    const sourceDir = join(dataDir, slug);
    const openApiDir = join(sourceDir, 'open-api');
    let apiFiles = [];
    try {
      apiFiles = (await readdir(openApiDir))
        .filter((name) => name.endsWith('.json'))
        .sort((a, b) => a.localeCompare(b));
    } catch {}

    return {
      id: slug,
      name: slug,
      repository: entry['github-repo'],
      capabilities: {
        database: Boolean(entry.dbschema) && await hasTables(join(sourceDir, 'db-schema', 'database.schema.json')),
        databaseScanned: Boolean(entry.dbschema) && await exists(join(sourceDir, 'db-schema', 'database.schema.json')),
        messages: Boolean(entry.eventcatalog) && await exists(join(sourceDir, 'event-catalog', 'events-and-commands.json')),
        dependencies: Boolean(entry['service-dependencies']) && await exists(join(sourceDir, 'service-dependencies', 'service-dependencies.json')),
        dependencyDiagram: Boolean(entry['service-dependencies']) && await exists(join(sourceDir, 'service-dependencies', 'service-dependencies.puml')),
        openapi: Boolean(entry.specs) && apiFiles.length > 0,
        security: await exists(join(sourceDir, 'dependency-alerts', 'dependabot-alerts.json')),
        localdev: await exists(join(sourceDir, 'local-dev-config', 'local-dev-config.json')),
        apiSecurity: await exists(join(sourceDir, 'api-security-audit', 'report.json')),
        metadata: Boolean(entry['repo-metadata']) && await exists(join(sourceDir, 'repo-metadata', 'repo-metadata.json')),
        topics: await exists(join(sourceDir, 'repo-topics', 'repo-topics.json'))
      },
      apiFiles,
      scans: Object.fromEntries(Object.entries(entry)
        .filter(([key]) => key !== 'github-repo')
        .map(([key, value]) => [key, value]))
    };
  }));
}

let catalogCache = null;

function getCatalog() {
  if (!catalogCache || Date.now() - catalogCache.builtAt > catalogCacheMs) {
    const pending = buildCatalog();
    catalogCache = { builtAt: Date.now(), pending };
    pending.catch(() => { if (catalogCache?.pending === pending) catalogCache = null; });
  }
  return catalogCache.pending;
}

// Generated data files per source, keyed by the kind used in /api/sources/:id/:kind.
const DATA_FILES = {
  database: ['db-schema', 'database.schema.json'],
  messages: ['event-catalog', 'events-and-commands.json'],
  dependencies: ['service-dependencies', 'service-dependencies.json'],
  security: ['dependency-alerts', 'dependabot-alerts.json'],
  localdev: ['local-dev-config', 'local-dev-config.json'],
  apisecurity: ['api-security-audit', 'report.json'],
  metadata: ['repo-metadata', 'repo-metadata.json'],
  topics: ['repo-topics', 'repo-topics.json']
};

// One source's data file, or null when it is missing or unreadable.
async function readSourceFile(source, kind) {
  const file = join(safeChild(dataDir, source.name), ...DATA_FILES[kind]);
  if (!await exists(file)) return null;
  try {
    return await readJson(file);
  } catch {
    return null;
  }
}

// Everything the home dashboard's tabs need, in one response instead of one request per source and tab.
async function buildDashboard(catalog) {
  return Promise.all(catalog.map(async (source) => {
    const [security, apiSecurity, metadata, topics, database] = await Promise.all([
      readSourceFile(source, 'security'),
      readSourceFile(source, 'apisecurity'),
      source.capabilities.metadata ? readSourceFile(source, 'metadata') : null,
      readSourceFile(source, 'topics'),
      source.capabilities.databaseScanned ? readSourceFile(source, 'database') : null
    ]);
    return { id: source.id, security, apiSecurity, metadata, topics: topics?.topics ?? null, database };
  }));
}

// Every source's dependencies, events/commands and topics, shared by the landscape and topics pages.
async function buildLandscapeData(catalog) {
  return Promise.all(catalog.map(async (source) => {
    const [dependencies, messages, topics] = await Promise.all([
      source.capabilities.dependencies ? readSourceFile(source, 'dependencies') : null,
      source.capabilities.messages ? readSourceFile(source, 'messages') : null,
      readSourceFile(source, 'topics')
    ]);
    return { id: source.id, dependencies, messages, topics: topics?.topics ?? null };
  }));
}

async function sourceById(id) {
  const catalog = await getCatalog();
  const source = catalog.find((item) => item.id === id);
  if (!source) throw Object.assign(new Error('Unknown source'), { statusCode: 404 });
  return source;
}

async function readSpecFiles(sourceDir, apiFiles) {
  return Promise.all(apiFiles.map(async (name) => ({ name, spec: await readJson(safeChild(join(sourceDir, 'open-api'), name)) })));
}

function safeChild(base, ...parts) {
  const target = resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw Object.assign(new Error('Invalid path'), { statusCode: 400 });
  }
  return target;
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/catalog') {
    return sendJson(response, 200, { sources: await getCatalog() });
  }
  if (url.pathname === '/api/dashboard') {
    return sendJson(response, 200, { sources: await buildDashboard(await getCatalog()) });
  }
  if (url.pathname === '/api/landscape') {
    return sendJson(response, 200, { sources: await buildLandscapeData(await getCatalog()) });
  }

  const diagramMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/dependency-diagram$/);
  if (diagramMatch) {
    const source = await sourceById(decodeURIComponent(diagramMatch[1]));
    const file = join(safeChild(dataDir, source.name), 'service-dependencies', 'service-dependencies.puml');
    if (!await exists(file)) return sendJson(response, 404, { error: 'PlantUML diagram is unavailable' });
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return createReadStream(file).pipe(response);
  }

  const postmanMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/(postman-collection|postman-environment)$/);
  if (postmanMatch) {
    const source = await sourceById(decodeURIComponent(postmanMatch[1]));
    if (!source.apiFiles.length) return sendJson(response, 404, { error: 'No OpenAPI specs available for this source' });
    const sourceDir = safeChild(dataDir, source.name);
    const specFiles = await readSpecFiles(sourceDir, source.apiFiles);
    if (postmanMatch[2] === 'postman-collection') {
      return sendDownload(response, `${source.name}.postman_collection.json`, buildPostmanCollection(source.name, specFiles));
    }
    const localDevFile = join(sourceDir, 'local-dev-config', 'local-dev-config.json');
    const localDevConfig = await exists(localDevFile) ? await readJson(localDevFile) : null;
    return sendDownload(response, `${source.name}.postman_environment.json`, buildPostmanEnvironment(source.name, specFiles, localDevConfig));
  }

  const match = url.pathname.match(/^\/api\/sources\/([^/]+)\/(database|messages|dependencies|openapi|security|localdev|apisecurity|metadata|topics)$/);
  if (!match) return sendJson(response, 404, { error: 'Not found' });

  const [, id, kind] = match;
  const source = await sourceById(decodeURIComponent(id));
  const sourceDir = safeChild(dataDir, source.name);
  let file = DATA_FILES[kind] ? join(sourceDir, ...DATA_FILES[kind]) : null;
  if (kind === 'openapi') {
    const requested = url.searchParams.get('file');
    if (!requested || !source.apiFiles.includes(requested)) {
      return sendJson(response, 400, { error: 'Select a valid OpenAPI file' });
    }
    file = safeChild(join(sourceDir, 'open-api'), requested);
  }

  if (!await exists(file)) return sendJson(response, 404, { error: `${kind} data is unavailable` });
  return sendJson(response, 200, await readJson(file));
}

function isAppRoute(pathname) {
  return pathname === '/' || pathname === '/landscape' || pathname === '/topics' || pathname === '/service' || pathname.startsWith('/service/');
}

async function serveStatic(response, pathname) {
  const requested = isAppRoute(pathname) ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = safeChild(publicDir, normalize(requested));
  if (!await exists(file)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return response.end('Not found');
  }
  response.writeHead(200, {
    'content-type': mimeTypes[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache'
  });
  createReadStream(file).pipe(response);
}

export const server = createServer(async (request, response) => {
  try {
    if (!isAuthorized(request)) return requireAuth(response);
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else await serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'Unable to read catalogue data' });
  }
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(port, '0.0.0.0', () => {
    console.log(`Service catalogue viewer listening on http://0.0.0.0:${port}`);
    console.log(`Reading catalogue data from ${dataDir}`);
    console.log(authPassword ? `Basic Auth enabled (user: ${authUser})` : 'Basic Auth disabled — set AUTH_PASSWORD to require credentials');
  });
}
