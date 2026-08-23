import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(appDir, 'public');
const dataDir = resolve(process.env.CATALOGUE_DATA_DIR || join(appDir, '..'));
const port = Number(process.env.PORT || 8080);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': mimeTypes['.json'], 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
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

async function buildCatalog() {
  const manifest = await readJson(join(dataDir, 'manifest.json'));
  return Promise.all(manifest.map(async (entry, index) => {
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
      id: String(index),
      name: slug,
      repository: entry['github-repo'],
      capabilities: {
        database: Boolean(entry.dbschema) && await exists(join(sourceDir, 'db-schema', 'database.schema.json')),
        messages: Boolean(entry.eventcatalog) && await exists(join(sourceDir, 'event-catalog', 'events-and-commands.json')),
        dependencies: Boolean(entry['service-dependencies']) && await exists(join(sourceDir, 'service-dependencies', 'service-dependencies.json')),
        openapi: Boolean(entry.specs) && apiFiles.length > 0
      },
      apiFiles,
      scans: Object.fromEntries(Object.entries(entry)
        .filter(([key]) => key !== 'github-repo')
        .map(([key, value]) => [key, value]))
    };
  }));
}

async function sourceById(id) {
  const catalog = await buildCatalog();
  const source = catalog.find((item) => item.id === id);
  if (!source) throw Object.assign(new Error('Unknown source'), { statusCode: 404 });
  return source;
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
    return sendJson(response, 200, { sources: await buildCatalog() });
  }

  const match = url.pathname.match(/^\/api\/sources\/([^/]+)\/(database|messages|dependencies|openapi)$/);
  if (!match) return sendJson(response, 404, { error: 'Not found' });

  const [, id, kind] = match;
  const source = await sourceById(decodeURIComponent(id));
  const sourceDir = safeChild(dataDir, source.name);
  let file;
  if (kind === 'database') file = join(sourceDir, 'db-schema', 'database.schema.json');
  if (kind === 'messages') file = join(sourceDir, 'event-catalog', 'events-and-commands.json');
  if (kind === 'dependencies') file = join(sourceDir, 'service-dependencies', 'service-dependencies.json');
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

async function serveStatic(response, pathname) {
  const requested = pathname === '/' || pathname === '/landscape' ? 'index.html' : decodeURIComponent(pathname.slice(1));
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
  });
}
