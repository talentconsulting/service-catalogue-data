import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.CATALOGUE_DATA_DIR = new URL('../..', import.meta.url).pathname;
const { server } = await import('../server.mjs');
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('catalog is derived from the manifest, keyed by repo slug', async () => {
  const response = await fetch(`${baseUrl}/api/catalog`);
  const body = await response.json();
  assert.equal(response.status, 200);
  const manifest = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
  assert.equal(body.sources.length, manifest.length);
  assert.equal(body.sources[0].name, 'das-learning');
  assert.equal(body.sources[0].id, 'das-learning');
  assert.equal(body.sources[1].name, 'das-courses-api');
  assert.equal(body.sources[1].capabilities.messages, false);
  assert.equal(body.sources[1].capabilities.dependencies, true);
});

test('unknown source id returns 404', async () => {
  const response = await fetch(`${baseUrl}/api/sources/does-not-exist/database`);
  assert.equal(response.status, 404);
});

test('database endpoint returns source tables', async () => {
  const response = await fetch(`${baseUrl}/api/sources/das-courses-api/database`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(body.tables.length > 0);
  assert.ok(body.tables[0].columns.length > 0);
});

test('database capability needs at least one table, but an empty schema still counts as scanned', async () => {
  const catalog = await (await fetch(`${baseUrl}/api/catalog`)).json();
  const withTables = catalog.sources.find((item) => item.id === 'das-courses-api');
  assert.equal(withTables.capabilities.database, true);
  assert.equal(withTables.capabilities.databaseScanned, true);
  const empty = catalog.sources.find((item) => item.id === 'das-payments-v2-common');
  assert.equal(empty.capabilities.database, false);
  assert.equal(empty.capabilities.databaseScanned, true);
});

test('OpenAPI endpoint only accepts catalogued files', async () => {
  const bad = await fetch(`${baseUrl}/api/sources/das-courses-api/openapi?file=../manifest.json`);
  assert.equal(bad.status, 400);
  const catalog = await (await fetch(`${baseUrl}/api/catalog`)).json();
  const source = catalog.sources.find((item) => item.id === 'das-courses-api');
  const file = source.apiFiles[0];
  const good = await fetch(`${baseUrl}/api/sources/das-courses-api/openapi?file=${encodeURIComponent(file)}`);
  assert.equal(good.status, 200);
  assert.ok((await good.json()).paths);
});

test('dependencies endpoint returns the generated dependency catalogue', async () => {
  const response = await fetch(`${baseUrl}/api/sources/das-commitments/dependencies`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.repository, 'SkillsFundingAgency/das-commitments');
  assert.ok(body.dependencies.length > 0);
  assert.ok(body.dependencies.every((dependency) => dependency.name && dependency.direction));
});

test('security endpoint is unavailable when a source has no generated data', async () => {
  const response = await fetch(`${baseUrl}/api/sources/das-learning/security`);
  assert.equal(response.status, 404);
});

test('dashboard endpoint returns every tab\'s data for every source in one response', async () => {
  const catalog = await (await fetch(`${baseUrl}/api/catalog`)).json();
  const body = await (await fetch(`${baseUrl}/api/dashboard`)).json();
  assert.deepEqual(body.sources.map((item) => item.id), catalog.sources.map((item) => item.id));
  const courses = body.sources.find((item) => item.id === 'das-courses-api');
  assert.ok(courses.database.tables.length > 0);
  assert.ok(Array.isArray(courses.topics));
  for (const item of body.sources) {
    assert.deepEqual(Object.keys(item).sort(), ['apiSecurity', 'database', 'id', 'metadata', 'security', 'topics']);
  }
});

test('landscape endpoint returns dependencies, messages and topics per source', async () => {
  const catalog = await (await fetch(`${baseUrl}/api/catalog`)).json();
  const body = await (await fetch(`${baseUrl}/api/landscape`)).json();
  assert.equal(body.sources.length, catalog.sources.length);
  for (const source of catalog.sources) {
    const item = body.sources.find((entry) => entry.id === source.id);
    assert.equal(item.dependencies !== null, source.capabilities.dependencies);
    assert.equal(item.messages !== null, source.capabilities.messages);
  }
});

test('JSON responses are gzipped when the client accepts it', async () => {
  const { request } = await import('node:http');
  const headers = await new Promise((resolve, reject) => {
    request(`${baseUrl}/api/landscape`, { headers: { 'accept-encoding': 'gzip' } }, (response) => {
      response.resume();
      resolve(response.headers);
    }).on('error', reject).end();
  });
  assert.equal(headers['content-encoding'], 'gzip');
});

test('dependencies endpoint serves the DfE overlay resolution when present', async () => {
  const response = await fetch(`${baseUrl}/api/sources/das-commitments/dependencies`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(body.resolution);
  assert.ok(body.dependencies.some((dependency) => dependency.targetRepo === 'das-courses-api' && dependency.via?.area === 'Approvals'));
});
