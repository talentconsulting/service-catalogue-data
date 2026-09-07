import assert from 'node:assert/strict';
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
  assert.equal(body.sources.length, 10);
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
