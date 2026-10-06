#!/usr/bin/env node
// DfE mapping layer over the generated service dependencies. A call into an APIM area is a route,
// not a dependency, so it is replaced by one dependency per inner API that area calls. Direct
// calls that the overlay recognises are pinned to their repository (targetRepo).
//
// Reads  dfe-overlay/apim-routing.json, das-apim-endpoints/apim-routes/apim-routes.json and
//        <repo>/service-dependencies/service-dependencies.json for every manifest entry.
// Writes <repo>/service-dependencies/resolved-dependencies.json. The scanned file is never changed.
//
// Usage: node dfe-overlay/resolve-dependencies.mjs [data-dir]

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_GATEWAY_EVIDENCE = 2;

const normalizeName = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/api$/, '');
const keySegments = (key) => String(key).split(/[:.]/);
const slugify = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function matchesRule(rule, dependency, repo) {
  if (rule.repo && rule.repo !== repo) return false;
  if (rule.configurationKey && (dependency.configurationKeys || []).some((key) => keySegments(key).includes(rule.configurationKey))) return true;
  return Boolean(rule.name) && normalizeName(dependency.name) === normalizeName(rule.name);
}

export function findGatewayArea(dependency, repo, overlay) {
  if (dependency.kind !== 'http-api' || repo === overlay.gateway.repo) return null;
  return Object.entries(overlay.gateway.areas)
    .find(([, area]) => area.match.some((rule) => matchesRule(rule, dependency, repo)))?.[0] ?? null;
}

// "ProviderRelationshipsApiConfiguration" -> "Provider Relationships API"
function nameFromConfiguration(configuration) {
  const base = configuration.replace(/Configuration$/, '').replace(/Inner/, '').replace(/Api$/, '');
  return `${base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')} API`;
}

export function innerApiFor(configuration, overlay) {
  const known = overlay.innerApis[configuration];
  return { name: known?.name || nameFromConfiguration(configuration), repo: known?.repo || null };
}

function findDirectInnerApi(dependency, overlay) {
  if (dependency.kind !== 'http-api') return null;
  return Object.values(overlay.innerApis).find((api) =>
    (api.names || []).some((name) => normalizeName(name) === normalizeName(dependency.name))
    || (api.configurationKeys || []).some((wanted) => (dependency.configurationKeys || []).some((key) => keySegments(key).includes(wanted)))) ?? null;
}

function routedDependencies(dependency, repo, area, context) {
  const route = context.routes.areas[area];
  if (!route) {
    return [{ ...dependency, via: { repo: context.overlay.gateway.repo, label: context.overlay.gateway.label, area, unresolved: true } }];
  }
  return route.innerApis.flatMap((inner) => {
    const api = innerApiFor(inner.configuration, context.overlay);
    // A caller reaching back to itself through APIM (das-commitments -> Approvals -> Commitments API) is not a dependency.
    if (api.repo === repo) return [];
    const targetRepo = api.repo && context.catalogued.has(api.repo) ? api.repo : null;
    return [{
      sourceId: dependency.sourceId,
      name: api.name,
      kind: 'http-api',
      classification: 'internal',
      direction: 'outbound',
      client: inner.clients.join(', '),
      technology: dependency.technology ?? null,
      configurationKeys: dependency.configurationKeys || [],
      authentication: dependency.authentication || { type: null, configurationKeys: [] },
      operations: [],
      resources: [],
      evidence: [
        ...(dependency.evidence || []).slice(0, MAX_GATEWAY_EVIDENCE),
        ...inner.evidence.map((sourceFile) => ({
          sourceFile: `${context.overlay.gateway.repo}/${sourceFile}`,
          reason: `${area} APIM area calls ${api.name} through ${inner.clients.join(', ')}`
        }))
      ],
      // Area-level: every inner API the area calls, not only those the caller's own routes reach.
      confidence: 'medium',
      targetId: `http-api-${slugify(api.name)}`,
      ...(targetRepo ? { targetRepo } : {}),
      description: `Calls via ${context.overlay.gateway.label} (${area})`,
      via: { repo: context.overlay.gateway.repo, label: context.overlay.gateway.label, area, dependencyName: dependency.name, operations: dependency.operations || [] }
    }];
  });
}

// One dependency per source container and target; a container reaching one inner API through two areas keeps both areas.
function mergeDuplicates(dependencies) {
  const merged = new Map();
  for (const dependency of dependencies) {
    if (!dependency.via || dependency.via.unresolved) {
      merged.set(Symbol('keep'), dependency);
      continue;
    }
    const key = `${dependency.sourceId}|${dependency.targetId}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...dependency, via: { ...dependency.via, areas: [dependency.via.area] } });
      continue;
    }
    if (!existing.via.areas.includes(dependency.via.area)) existing.via.areas.push(dependency.via.area);
    existing.evidence = [...existing.evidence, ...dependency.evidence.filter((item) => !existing.evidence.some((seen) => seen.sourceFile === item.sourceFile))];
  }
  return [...merged.values()].map((dependency) => {
    if (!dependency.via?.areas) return dependency;
    const areas = dependency.via.areas.sort();
    return { ...dependency, description: `Calls via ${dependency.via.label} (${areas.join(', ')})`, via: { ...dependency.via, area: areas.join(', ') } };
  });
}

export function resolveDependencies(document, repo, context) {
  const { overlay } = context;
  if (repo === overlay.gateway.repo) {
    return { ...document, role: 'gateway', hideInLandscape: Boolean(overlay.gateway.hideInLandscape) };
  }
  const additional = (overlay.additionalCalls || [])
    .filter((call) => call.repo === repo)
    .map((call) => ({
      sourceId: call.sourceId, name: call.name, kind: 'http-api', classification: 'internal', direction: 'outbound',
      configurationKeys: call.configurationKeys || [], operations: [], resources: [], evidence: call.evidence || [], confidence: 'high'
    }));

  const resolved = [...(document.dependencies || []), ...additional].flatMap((dependency) => {
    const area = findGatewayArea(dependency, repo, overlay);
    if (area) return routedDependencies(dependency, repo, area, context);
    const direct = findDirectInnerApi(dependency, overlay);
    if (direct?.repo && direct.repo !== repo && context.catalogued.has(direct.repo)) return [{ ...dependency, targetRepo: direct.repo }];
    return [dependency];
  });

  return {
    ...document,
    dependencies: mergeDuplicates(resolved),
    resolution: { overlay: 'dfe-overlay/apim-routing.json', apimCommit: context.routes.commit ?? null, precision: 'area' }
  };
}

const repoSlug = (url) => url.replace(/\/+$/, '').split('/').pop();

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function resolveAll(dataDir) {
  const overlay = JSON.parse(await readFile(join(dataDir, 'dfe-overlay', 'apim-routing.json'), 'utf8'));
  const routes = JSON.parse(await readFile(join(dataDir, overlay.gateway.repo, 'apim-routes', 'apim-routes.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(dataDir, 'manifest.json'), 'utf8'));
  const catalogued = new Set(manifest.map((entry) => repoSlug(entry['github-repo'])));
  const written = [];
  for (const repo of catalogued) {
    const dir = join(dataDir, repo, 'service-dependencies');
    const document = await readJsonIfPresent(join(dir, 'service-dependencies.json'));
    if (!document) continue;
    const resolved = resolveDependencies(document, repo, { overlay, routes, catalogued });
    await writeFile(join(dir, 'resolved-dependencies.json'), `${JSON.stringify(resolved, null, 2)}\n`);
    written.push(repo);
  }
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = resolve(process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..'));
  const written = await resolveAll(dataDir);
  console.log(`Wrote resolved dependencies for ${written.length} repositories`);
}
