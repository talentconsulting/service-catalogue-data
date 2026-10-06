#!/usr/bin/env node
// Reads a das-apim-endpoints checkout and records, per APIM area (src/<Area>), which inner APIs the
// area calls. Inner API clients are typed by their configuration class, e.g.
// ICoursesApiClient<CoursesApiConfiguration> or InternalApiClient<CommitmentsV2ApiConfiguration>.
//
// Usage: node dfe-overlay/extract-apim-routes.mjs <path-to-das-apim-endpoints> [data-dir]

import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_RE = /\b(\w*Client)<(\w+Configuration)>/g;
// Test, fake and stub projects call nothing for real.
const IGNORED_DIR_RE = /(^|\.)(tests?|unittests|integrationtests|acceptancetests|testharness|fakeapis|mockapis|stubs)$|^(bin|obj|node_modules|\.git)$/i;
const MAX_EVIDENCE = 3;

async function* csFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIR_RE.test(entry.name)) yield* csFiles(join(dir, entry.name));
    } else if (entry.name.endsWith('.cs')) {
      yield join(dir, entry.name);
    }
  }
}

export async function extractArea(apimDir, area) {
  const byConfiguration = new Map();
  for await (const file of csFiles(join(apimDir, 'src', area))) {
    const text = await readFile(file, 'utf8');
    for (const [, client, configuration] of text.matchAll(CLIENT_RE)) {
      if (!byConfiguration.has(configuration)) byConfiguration.set(configuration, { configuration, clients: new Set(), usages: 0, evidence: [] });
      const entry = byConfiguration.get(configuration);
      entry.clients.add(client);
      entry.usages += 1;
      const sourceFile = relative(apimDir, file).split(sep).join('/');
      if (entry.evidence.length < MAX_EVIDENCE && !entry.evidence.includes(sourceFile)) entry.evidence.push(sourceFile);
    }
  }
  return [...byConfiguration.values()]
    .map((entry) => ({ ...entry, clients: [...entry.clients].sort() }))
    .sort((a, b) => b.usages - a.usages || a.configuration.localeCompare(b.configuration));
}

function commitOf(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export async function extractRoutes(apimDir) {
  const areas = {};
  const names = (await readdir(join(apimDir, 'src'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== 'Shared')
    .map((entry) => entry.name)
    .sort();
  for (const area of names) {
    const innerApis = await extractArea(apimDir, area);
    if (innerApis.length) areas[area] = { path: `src/${area}`, innerApis };
  }
  return { repository: 'SkillsFundingAgency/das-apim-endpoints', commit: commitOf(apimDir), areas };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [apimArg, dataArg] = process.argv.slice(2);
  if (!apimArg) {
    console.error('Usage: node dfe-overlay/extract-apim-routes.mjs <path-to-das-apim-endpoints> [data-dir]');
    process.exit(1);
  }
  const dataDir = resolve(dataArg || join(fileURLToPath(new URL('.', import.meta.url)), '..'));
  const routes = await extractRoutes(resolve(apimArg));
  const outDir = join(dataDir, 'das-apim-endpoints', 'apim-routes');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'apim-routes.json'), `${JSON.stringify(routes, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(routes.areas).length} APIM areas to ${relative(process.cwd(), join(outDir, 'apim-routes.json'))}`);
}
