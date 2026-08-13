const state = {
  catalog: [], source: null, view: 'database', data: null,
  filter: '', selected: null, messageType: 'all', apiFile: null,
  mode: 'source', landscape: null
};

const $ = (selector) => document.querySelector(selector);
const sourceSelect = $('#source-select');
const content = $('#content');
const toolbar = $('#toolbar');
const tabs = $('#view-tabs');
const landscapeToggle = $('#landscape-toggle');
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const titleCase = (value) => value.replace(/(^|[-_])(\w)/g, (_, space, char) => `${space ? ' ' : ''}${char.toUpperCase()}`);

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function sourceCapabilities() {
  return [
    { id: 'database', label: 'Data schema', enabled: state.source.capabilities.database },
    { id: 'messages', label: 'Events & commands', enabled: state.source.capabilities.messages },
    { id: 'dependencies', label: 'Dependencies', enabled: state.source.capabilities.dependencies },
    { id: 'openapi', label: 'API specs', enabled: state.source.capabilities.openapi }
  ];
}

function renderTabs() {
  tabs.innerHTML = sourceCapabilities().map((tab) => `
    <button class="tab" type="button" data-view="${tab.id}" aria-selected="${state.view === tab.id}" ${tab.enabled ? '' : 'disabled'}>
      ${tab.label}${tab.enabled ? '' : '<span class="count">—</span>'}
    </button>`).join('');
}

function setHero() {
  $('#source-title').textContent = titleCase(state.source.name);
  const link = $('#repo-link');
  link.textContent = state.source.repository.replace('https://github.com/', 'github.com/');
  link.href = state.source.repository;
  const available = Object.values(state.source.capabilities).filter(Boolean).length;
  const commit = Object.values(state.source.scans)[0]?.['last-commit-hash-scanned'] || '';
  $('#source-stats').innerHTML = `
    <div class="stat"><dt>Views</dt><dd>${available}</dd></div>
    <div class="stat"><dt>API specs</dt><dd>${state.source.apiFiles.length}</dd></div>
    <div class="stat"><dt>Commit</dt><dd title="${escapeHtml(commit)}">${escapeHtml(commit.slice(0, 7))}</dd></div>`;
}

function defaultView() {
  return sourceCapabilities().find((item) => item.enabled)?.id || 'database';
}

function applyMode() {
  const isLandscape = state.mode === 'landscape';
  document.querySelector('main').classList.toggle('landscape-mode', isLandscape);
  landscapeToggle.setAttribute('aria-pressed', String(isLandscape));
  landscapeToggle.textContent = isLandscape ? '← Back to source' : 'System landscape';
}

async function selectSource(id) {
  state.source = state.catalog.find((source) => source.id === id);
  if (!state.source.capabilities[state.view]) state.view = defaultView();
  state.filter = '';
  state.selected = null;
  state.apiFile = state.source.apiFiles[0] || null;
  setHero();
  renderTabs();
  await loadView();
}

async function loadView() {
  toolbar.innerHTML = '';
  content.innerHTML = '<div class="loading">Reading catalogue data…</div>';
  state.filter = '';
  state.selected = null;
  try {
    let url = `/api/sources/${encodeURIComponent(state.source.id)}/${state.view}`;
    if (state.view === 'openapi') url += `?file=${encodeURIComponent(state.apiFile)}`;
    state.data = await getJson(url);
    renderView();
  } catch (error) {
    content.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

function searchControl(placeholder) {
  return `<input id="search" type="search" value="${escapeHtml(state.filter)}" placeholder="${placeholder}" aria-label="${placeholder}">`;
}

function wireSearch() {
  const search = $('#search');
  if (!search) return;
  search.oninput = (event) => {
    state.filter = event.target.value.toLowerCase();
    renderView(false);
    $('#search')?.focus();
  };
}

function renderDatabase(resetToolbar = true) {
  const tables = state.data.tables || [];
  const relations = tables.reduce((sum, table) => sum + (table.relationships?.length || 0), 0);
  const columns = tables.reduce((sum, table) => sum + (table.columns?.length || 0), 0);
  if (resetToolbar) {
    toolbar.innerHTML = `${searchControl('Filter tables or columns')}<span class="spacer"></span><span class="toolbar-meta">${tables.length} tables · ${columns} columns · ${relations} relationships</span>`;
  }
  const filtered = tables.filter((table) => `${table.schema} ${table.name} ${table.columns?.map((column) => column.name).join(' ')}`.toLowerCase().includes(state.filter));
  content.innerHTML = `<div class="schema-grid">${filtered.map((table) => {
    const outbound = table.relationships || [];
    return `<button class="schema-card" type="button" data-table="${escapeHtml(table.name)}">
      <h2>${escapeHtml(table.schema)}.${escapeHtml(table.name)}</h2>
      <p>${table.columns?.length || 0} columns · ${table.indexes?.length || 0} indexes</p>
      <ul class="relation-list">${outbound.slice(0, 3).map((rel) => `<li>→ <strong>${escapeHtml(rel.targetTable)}</strong> via ${escapeHtml(rel.fromColumns?.join(', '))}</li>`).join('')}${outbound.length > 3 ? `<li>+ ${outbound.length - 3} more</li>` : ''}</ul>
    </button>`;
  }).join('')}</div>`;
  if (!filtered.length) content.innerHTML = '<div class="empty-state"><h2>No matching tables</h2><p>Try a different search term.</p></div>';
  wireSearch();
  document.querySelectorAll('[data-table]').forEach((button) => button.addEventListener('click', () => renderTableDetail(tables.find((table) => table.name === button.dataset.table))));
}

function renderTableDetail(table) {
  const incoming = (state.data.tables || []).flatMap((candidate) => (candidate.relationships || [])
    .filter((relation) => relation.targetTable === table.name)
    .map((relation) => ({ ...relation, fromTable: candidate.name })));
  toolbar.innerHTML = '<button id="back" class="plain-button" type="button">← All tables</button>';
  content.innerHTML = `<article class="detail standalone">
    <p class="eyebrow">${escapeHtml(table.schema)} schema</p><h2>${escapeHtml(table.name)}</h2>
    <div class="badges"><span class="badge">${table.columns.length} columns</span><span class="badge blue">${table.indexes?.length || 0} indexes</span><span class="badge amber">${(table.relationships?.length || 0) + incoming.length} links</span></div>
    <h3>Columns</h3>${columnsTable(table.columns)}
    <h3>Relationships</h3>${relationshipsTable(table.relationships || [], incoming)}
    <h3>Indexes</h3>${indexesTable(table.indexes || [])}
  </article>`;
  $('#back').addEventListener('click', () => { state.filter = ''; renderDatabase(true); });
}

function columnsTable(columns) {
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Properties</th></tr></thead><tbody>${columns.map((column) => `<tr><td><code>${escapeHtml(column.name)}</code></td><td>${escapeHtml(column.type)}</td><td>${column.nullable ? 'Yes' : 'No'}</td><td>${[column.primaryKey && 'Primary key', column.generated && 'Generated', column.default && `Default: ${column.default}`].filter(Boolean).map((label) => `<span class="badge">${escapeHtml(label)}</span>`).join(' ') || '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>`;
}

function relationshipsTable(outbound, incoming) {
  const rows = [
    ...outbound.map((rel) => [rel.fromColumns?.join(', '), '→', rel.targetTable, rel.targetColumns?.join(', '), rel.name]),
    ...incoming.map((rel) => [rel.targetColumns?.join(', '), '←', rel.fromTable, rel.fromColumns?.join(', '), rel.name])
  ];
  if (!rows.length) return '<p class="muted">No relationships recorded.</p>';
  return `<table class="data-table"><thead><tr><th>Local columns</th><th></th><th>Related table</th><th>Related columns</th><th>Constraint</th></tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell, index) => `<td${index === 1 ? ' class="muted"' : ''}>${escapeHtml(cell || '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function indexesTable(indexes) {
  if (!indexes.length) return '<p class="muted">No indexes recorded.</p>';
  return `<table class="data-table"><thead><tr><th>Name</th><th>Columns</th><th>Type</th><th>Unique</th></tr></thead><tbody>${indexes.map((index) => `<tr><td>${escapeHtml(index.name)}</td><td><code>${escapeHtml(index.columns?.join(', '))}</code></td><td>${escapeHtml(index.type)}</td><td>${index.unique ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table>`;
}

function messages() {
  const events = (state.data.events || []).map((message) => ({ ...message, kind: 'event' }));
  const commands = (state.data.commands || []).map((message) => ({ ...message, kind: 'command' }));
  return [...events, ...commands].sort((a, b) => a.name.localeCompare(b.name));
}

function renderMessages(resetToolbar = true) {
  const all = messages();
  if (resetToolbar) toolbar.innerHTML = `${searchControl('Filter events and commands')}<div class="segmented" role="group" aria-label="Message type"><button data-kind="all" aria-pressed="${state.messageType === 'all'}">All</button><button data-kind="event" aria-pressed="${state.messageType === 'event'}">Events</button><button data-kind="command" aria-pressed="${state.messageType === 'command'}">Commands</button></div><span class="spacer"></span><span class="toolbar-meta">${state.data.events?.length || 0} events · ${state.data.commands?.length || 0} commands</span>`;
  const filtered = all.filter((message) => (state.messageType === 'all' || message.kind === state.messageType) && `${message.name} ${message.namespace} ${message.sourceFile}`.toLowerCase().includes(state.filter));
  if (!state.selected || !filtered.some((message) => `${message.kind}:${message.name}` === state.selected)) state.selected = filtered[0] ? `${filtered[0].kind}:${filtered[0].name}` : null;
  const selected = all.find((message) => `${message.kind}:${message.name}` === state.selected);
  content.innerHTML = `<div class="split"><aside class="item-list">${filtered.map((message) => `<button class="list-button" type="button" data-message="${escapeHtml(`${message.kind}:${message.name}`)}" aria-current="${state.selected === `${message.kind}:${message.name}`}"><span class="list-title">${escapeHtml(message.name)}</span><span class="list-meta">${titleCase(message.kind)} · ${message.fields?.length || 0} fields · ${message.handlers?.length || 0} handlers</span></button>`).join('') || '<div class="detail muted">No matching messages.</div>'}</aside><div class="detail">${selected ? messageDetail(selected) : ''}</div></div>`;
  wireSearch();
  document.querySelectorAll('[data-kind]').forEach((button) => { button.onclick = () => { state.messageType = button.dataset.kind; state.selected = null; renderMessages(true); }; });
  document.querySelectorAll('[data-message]').forEach((button) => button.addEventListener('click', () => { state.selected = button.dataset.message; renderMessages(false); }));
}

function messageDetail(message) {
  return `<span class="badge ${message.kind === 'command' ? 'amber' : ''}">${message.kind}</span><h2>${escapeHtml(message.name)}</h2><p class="detail-subtitle">${escapeHtml(message.namespace || 'Namespace not recorded')}</p>
    <h3>Payload</h3>${message.fields?.length ? `<table class="data-table"><thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>${message.fields.map((field) => `<tr><td><code>${escapeHtml(field.name)}</code></td><td>${escapeHtml(field.type)}</td><td>${field.required ? 'Yes' : 'No'}</td><td class="muted">${escapeHtml(field.description || '—')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No payload fields recorded.</p>'}
    <h3>Handlers</h3>${message.handlers?.length ? message.handlers.map((handler) => `<p><strong>${escapeHtml(handler.name)}</strong><br>${sourceLink(handler.sourceFile)}</p>`).join('') : '<p class="muted">No handlers recorded.</p>'}
    <h3>Source</h3>${sourceLink(message.sourceFile)}`;
}

function splitPascalCase(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
}

function c4Type(dependency) {
  return dependency.classification === 'internal' ? 'Container' : 'External System';
}

function orgName(repository) {
  return (repository || '').split('/')[0] || 'System';
}

function orgFromRepoUrl(url) {
  return (url || '').replace(/^https?:\/\/[^/]+\//, '').split('/')[0] || 'System';
}

function relationshipLabel(dependency) {
  const verb = dependency.direction === 'inbound' ? 'Called by' : 'Calls';
  const kindLabel = dependency.kind === 'http-api' ? 'HTTP' : dependency.kind;
  const seen = new Set();
  const parts = [kindLabel, dependency.technology].filter(Boolean).filter((value) => {
    const key = value.toString().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return `${verb}${parts.length ? ` [${parts.join('/')}]` : ''}`;
}

const LANDSCAPE_STOPWORDS = new Set(['das', 'sfa', 'api', 'apis', 'client', 'clients', 'service', 'services', 'http', 'https', 'httpclient', 'httphelper', 'httpservice', 'wrapper', 'outer', 'inner', 'the', 'a', 'an', 'i', 'v1', 'v2', 'v3']);

function tokenize(value) {
  return splitPascalCase(String(value || ''))
    .split(/[^a-zA-Z0-9]+/)
    .map((word) => word.toLowerCase())
    .map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))
    .filter((word) => word.length > 1 && !LANDSCAPE_STOPWORDS.has(word));
}

function isSubset(small, big) {
  for (const token of small) if (!big.has(token)) return false;
  return true;
}

function canRelate(a, b) {
  return a.size > 0 && b.size > 0 && (isSubset(a, b) || isSubset(b, a));
}

function edgeLabel(edge) {
  const technology = edge.technologies.join('/');
  return `Calls${technology ? ` [${technology}]` : ''}${edge.count > 1 ? ` ×${edge.count}` : ''}`;
}

function buildLandscape(sources, dependencySets) {
  const systemTokenMap = new Map(sources.map((s) => [s.id, new Set(tokenize(s.name))]));
  const edgeMap = new Map();

  function addEdge(from, to, dependency) {
    const key = `${from}|${to}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { from, to, count: 0, operations: 0, technologies: new Set(), names: new Set() });
    const edge = edgeMap.get(key);
    edge.count += 1;
    edge.operations += dependency.operations?.length || 0;
    const kindLabel = dependency.kind === 'http-api' ? 'HTTP' : dependency.kind;
    [kindLabel, dependency.technology].filter(Boolean).forEach((value) => edge.technologies.add(value));
    edge.names.add(dependency.name);
  }

  const externalEntries = [];
  for (const { source, dependencies } of dependencySets) {
    const ownTokens = systemTokenMap.get(source.id);
    for (const dependency of dependencies) {
      const depTokens = new Set(tokenize(dependency.name));
      if (canRelate(depTokens, ownTokens)) continue;
      const matchedSystem = sources.find((candidate) => candidate.id !== source.id && canRelate(depTokens, systemTokenMap.get(candidate.id)));
      if (matchedSystem) {
        addEdge(`sys:${source.id}`, `sys:${matchedSystem.id}`, dependency);
        continue;
      }
      if (depTokens.size === 0) continue;
      externalEntries.push({ source, dependency, tokens: depTokens });
    }
  }

  const parent = externalEntries.map((_, index) => index);
  const find = (i) => { while (parent[i] !== i) i = parent[i]; return i; };
  for (let i = 0; i < externalEntries.length; i++) {
    for (let j = i + 1; j < externalEntries.length; j++) {
      if (canRelate(externalEntries[i].tokens, externalEntries[j].tokens)) parent[find(i)] = find(j);
    }
  }

  const clusters = new Map();
  externalEntries.forEach((entry, index) => {
    const root = find(index);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(entry);
  });

  const externals = [];
  let extIndex = 0;
  for (const members of clusters.values()) {
    const id = `ext:${extIndex++}`;
    const name = members.reduce((best, member) => (member.dependency.name.length > best.length ? member.dependency.name : best), members[0].dependency.name);
    members.forEach((member) => addEdge(`sys:${member.source.id}`, id, member.dependency));
    externals.push({ id, name, members });
  }

  const systems = sources.map((s) => ({ id: `sys:${s.id}`, sourceId: s.id, name: s.name, repository: s.repository }));
  const edges = [...edgeMap.values()].map((edge) => ({ ...edge, technologies: [...edge.technologies], names: [...edge.names] }));
  return { systems, externals, edges };
}

function ringLayout(group, center, radiusX, radiusY, angleOffset = 0) {
  return group.map((dependency, index) => {
    const angle = group.length === 1 ? -Math.PI / 2 : (Math.PI * 2 * index / group.length) - Math.PI / 2 + angleOffset;
    return { ...dependency, x: center.x + Math.cos(angle) * radiusX, y: center.y + Math.sin(angle) * radiusY };
  });
}

function renderDependencies(resetToolbar = true) {
  const dependencies = (state.data.dependencies || []).map((dependency, index) => ({ ...dependency, id: String(index) }));
  const operations = dependencies.reduce((sum, dependency) => sum + (dependency.operations?.length || 0), 0);
  const internalCount = dependencies.filter((dependency) => dependency.classification === 'internal').length;
  if (resetToolbar) toolbar.innerHTML = `${searchControl('Filter dependencies')}<span class="spacer"></span><span class="toolbar-meta">${dependencies.length} dependencies · ${internalCount} internal · ${dependencies.length - internalCount} external · ${operations} operations</span>`;
  const filtered = dependencies.filter((dependency) => `${dependency.name} ${dependency.kind} ${dependency.classification} ${dependency.direction} ${dependency.client} ${dependency.technology}`.toLowerCase().includes(state.filter));
  if (!dependencies.length) {
    content.innerHTML = '<div class="empty-state"><span class="empty-icon" aria-hidden="true">◇</span><h2>No service dependencies recorded</h2><p>The generated dependency catalogue is empty.</p></div>';
    return;
  }
  if (!filtered.length) {
    content.innerHTML = '<div class="empty-state"><h2>No matching dependencies</h2><p>Try a different search term.</p></div>';
    wireSearch();
    return;
  }
  if (!state.selected || !filtered.some((item) => item.id === state.selected)) state.selected = filtered[0].id;
  const selected = dependencies.find((item) => item.id === state.selected);
  const VIEW_W = 1400, VIEW_H = 800;
  const center = { x: VIEW_W / 2, y: VIEW_H / 2 };
  const nodeHalfW = 98, nodeHalfH = 48, pad = 26;
  const internalRx = 270, internalRy = 150;
  const boundaryRx = internalRx + nodeHalfW + pad;
  const boundaryRy = internalRy + nodeHalfH + pad;
  const externalScale = 1.4;
  const internal = ringLayout(filtered.filter((d) => d.classification === 'internal'), center, internalRx, internalRy, 0);
  const external = ringLayout(filtered.filter((d) => d.classification !== 'internal'), center, boundaryRx * externalScale, boundaryRy * externalScale, Math.PI / 5);
  const nodes = [...internal, ...external];
  const pct = (value, axis) => `${((value / (axis === 'x' ? VIEW_W : VIEW_H)) * 100).toFixed(2)}%`;
  content.innerHTML = `<div class="dependency-view">
    <div class="c4-legend">
      <span class="c4-legend-item"><span class="c4-swatch focus"></span>Software system (this service)</span>
      <span class="c4-legend-item"><span class="c4-swatch internal"></span>Container — internal</span>
      <span class="c4-legend-item"><span class="c4-swatch external"></span>External system</span>
      <span class="c4-legend-item"><span class="c4-boundary-swatch"></span>${escapeHtml(orgName(state.data.repository))} system boundary</span>
    </div>
    <div class="dependency-graph" role="group" aria-label="C4 container diagram for ${escapeHtml(titleCase(state.source.name))}">
      <svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="arrow-outbound" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>
          <marker id="arrow-inbound" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>
        </defs>
        <ellipse class="c4-boundary" cx="${center.x}" cy="${center.y}" rx="${boundaryRx}" ry="${boundaryRy}"></ellipse>
        <text class="c4-boundary-label" x="${center.x - boundaryRx + 18}" y="${center.y - boundaryRy + 26}">${escapeHtml(orgName(state.data.repository))}</text>
        ${nodes.map((node) => {
          const [x1, y1, x2, y2] = node.direction === 'inbound' ? [node.x, node.y, center.x, center.y] : [center.x, center.y, node.x, node.y];
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;
          const label = relationshipLabel(node);
          return `<line class="${escapeHtml(node.direction === 'inbound' ? 'inbound' : 'outbound')}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#arrow-${node.direction === 'inbound' ? 'inbound' : 'outbound'})"></line>
            <rect class="rel-label-bg" x="${midX - label.length * 3.3}" y="${midY - 9}" width="${label.length * 6.6}" height="15" rx="4"></rect>
            <text class="rel-label" x="${midX}" y="${midY + 2}" text-anchor="middle">${escapeHtml(label)}</text>`;
        }).join('')}
      </svg>
      <div class="dependency-node service-node" style="left:${pct(center.x, 'x')};top:${pct(center.y, 'y')}"><span class="c4-type">Software System</span><strong>${escapeHtml(titleCase(state.source.name))}</strong></div>
      ${nodes.map((node) => `<button class="dependency-node ${node.classification === 'internal' ? 'internal' : 'external'}" type="button" data-dependency="${escapeHtml(node.id)}" aria-pressed="${node.id === state.selected}" style="left:${pct(node.x, 'x')};top:${pct(node.y, 'y')}"><span class="c4-type">${escapeHtml(c4Type(node))}</span><strong>${escapeHtml(splitPascalCase(node.name))}</strong><span class="c4-meta">${escapeHtml(node.technology || node.kind || 'service')} · ${node.operations?.length || 0} op${node.operations?.length === 1 ? '' : 's'}</span></button>`).join('')}
    </div>
    ${dependencyDetail(selected)}
  </div>`;
  wireSearch();
  document.querySelectorAll('[data-dependency]').forEach((button) => { button.onclick = () => { state.selected = button.dataset.dependency; renderDependencies(false); }; });
}

function dependencyDetail(dependency) {
  const authentication = dependency.authentication || {};
  const facts = [
    ['Type', c4Type(dependency)],
    ['Client', dependency.client],
    ['Technology', dependency.technology],
    ['Authentication', authentication.type],
    ['Confidence', dependency.confidence]
  ];
  return `<article class="dependency-detail">
    <p class="eyebrow">${escapeHtml(dependency.direction || 'Unknown')} dependency</p>
    <h2>${escapeHtml(dependency.name)}</h2>
    <div class="badges"><span class="badge blue">${escapeHtml(dependency.kind || 'service')}</span><span class="badge ${dependency.classification === 'unknown' ? 'amber' : ''}">${escapeHtml(dependency.classification || 'unknown')}</span></div>
    <dl class="dependency-facts">${facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value || 'Not recorded')}</dd></div>`).join('')}</dl>
    <h3>Operations</h3>${dependencyOperations(dependency.operations || [])}
    <h3>Configuration</h3>${dependencyKeys([...(dependency.configurationKeys || []), ...(authentication.configurationKeys || [])])}
    ${(dependency.resources || []).length ? `<h3>Resources</h3>${dependencyResources(dependency.resources)}` : ''}
    <h3>Evidence</h3>${dependencyEvidence(dependency.evidence || [])}
  </article>`;
}

function dependencyOperations(operations) {
  if (!operations.length) return '<p class="muted">No operations recorded.</p>';
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Method</th><th>Path</th><th>Source</th></tr></thead><tbody>${operations.map((operation) => `<tr><td><span class="method ${escapeHtml((operation.method || '').toLowerCase())}">${escapeHtml(operation.method || '—')}</span></td><td><code>${escapeHtml(operation.path || 'Not resolved')}</code></td><td>${sourceLink(operation.sourceFile, 'service-dependencies')}</td></tr>`).join('')}</tbody></table></div>`;
}

function dependencyKeys(keys) {
  const unique = [...new Set(keys)].sort((a, b) => a.localeCompare(b));
  return unique.length ? `<ul class="code-list">${unique.map((key) => `<li><code>${escapeHtml(key)}</code></li>`).join('')}</ul>` : '<p class="muted">No configuration keys recorded.</p>';
}

function dependencyResources(resources) {
  return `<table class="data-table"><thead><tr><th>Name</th><th>Type</th></tr></thead><tbody>${resources.map((resource) => `<tr><td>${escapeHtml(resource.name || resource.path || 'Unnamed')}</td><td>${escapeHtml(resource.type || resource.kind || 'Not recorded')}</td></tr>`).join('')}</tbody></table>`;
}

function dependencyEvidence(evidence) {
  if (!evidence.length) return '<p class="muted">No source evidence recorded.</p>';
  return `<ol class="evidence-list">${evidence.map((item) => `<li><p>${escapeHtml(item.reason || 'Dependency reference')}</p>${sourceLink(item.sourceFile, 'service-dependencies')}</li>`).join('')}</ol>`;
}

function setLandscapeHero() {
  $('#source-title').textContent = 'System landscape';
  $('#source-stats').innerHTML = '';
}

async function loadLandscape() {
  toolbar.innerHTML = '';
  content.innerHTML = '<div class="loading">Reading catalogue data…</div>';
  state.selected = null;
  try {
    const withDeps = state.catalog.filter((source) => source.capabilities.dependencies);
    const results = await Promise.all(withDeps.map((source) => getJson(`/api/sources/${encodeURIComponent(source.id)}/dependencies`)
      .then((data) => ({ source, dependencies: data.dependencies || [] }))
      .catch(() => null)));
    state.landscape = buildLandscape(state.catalog, results.filter(Boolean));
    renderLandscape();
  } catch (error) {
    content.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

function renderLandscape() {
  const graph = state.landscape;
  const allNodes = [...graph.systems, ...graph.externals];
  $('#source-stats').innerHTML = `
    <div class="stat"><dt>Systems</dt><dd>${graph.systems.length}</dd></div>
    <div class="stat"><dt>External</dt><dd>${graph.externals.length}</dd></div>
    <div class="stat"><dt>Relationships</dt><dd>${graph.edges.length}</dd></div>`;
  toolbar.innerHTML = `<span class="toolbar-meta">Inferred by matching each repository's outbound service dependencies against the catalogue and clustering the rest as external systems</span>`;
  if (!allNodes.length) {
    content.innerHTML = '<div class="empty-state"><span class="empty-icon" aria-hidden="true">◇</span><h2>No dependency data available</h2><p>None of the cataloged repositories publish service-dependencies data.</p></div>';
    return;
  }
  if (!state.selected || !allNodes.some((node) => node.id === state.selected)) state.selected = graph.systems[0]?.id || graph.externals[0]?.id;
  const selected = allNodes.find((node) => node.id === state.selected);

  const VIEW_W = 1440, VIEW_H = 880;
  const center = { x: VIEW_W / 2, y: VIEW_H / 2 };
  const nodeHalfW = 98, nodeHalfH = 48, pad = 26;
  const systemsRx = 300, systemsRy = 190;
  const boundaryRx = systemsRx + nodeHalfW + pad;
  const boundaryRy = systemsRy + nodeHalfH + pad;
  const externalScale = 1.4;
  const systemNodes = ringLayout(graph.systems, center, systemsRx, systemsRy, 0);
  const externalNodes = ringLayout(graph.externals, center, boundaryRx * externalScale, boundaryRy * externalScale, graph.externals.length ? Math.PI / graph.externals.length : 0);
  const posById = new Map([...systemNodes, ...externalNodes].map((node) => [node.id, node]));
  const pct = (value, axis) => `${((value / (axis === 'x' ? VIEW_W : VIEW_H)) * 100).toFixed(2)}%`;
  const orgLabel = orgFromRepoUrl(graph.systems[0]?.repository);

  content.innerHTML = `<div class="dependency-view">
    <div class="c4-legend">
      <span class="c4-legend-item"><span class="c4-swatch internal"></span>Software system (cataloged)</span>
      <span class="c4-legend-item"><span class="c4-swatch external"></span>External system</span>
      <span class="c4-legend-item"><span class="c4-boundary-swatch"></span>${escapeHtml(orgLabel)} system boundary</span>
    </div>
    <div class="dependency-graph" role="group" aria-label="C4 system landscape diagram">
      <svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="arrow-outbound" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>
        </defs>
        <ellipse class="c4-boundary" cx="${center.x}" cy="${center.y}" rx="${boundaryRx}" ry="${boundaryRy}"></ellipse>
        <text class="c4-boundary-label" x="${center.x - boundaryRx + 18}" y="${center.y - boundaryRy + 26}">${escapeHtml(orgLabel)}</text>
        ${graph.edges.map((edge) => {
          const from = posById.get(edge.from);
          const to = posById.get(edge.to);
          if (!from || !to) return '';
          const midX = (from.x + to.x) / 2;
          const midY = (from.y + to.y) / 2;
          const label = edgeLabel(edge);
          return `<line class="outbound" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" marker-end="url(#arrow-outbound)"></line>
            <rect class="rel-label-bg" x="${midX - label.length * 3.3}" y="${midY - 9}" width="${label.length * 6.6}" height="15" rx="4"></rect>
            <text class="rel-label" x="${midX}" y="${midY + 2}" text-anchor="middle">${escapeHtml(label)}</text>`;
        }).join('')}
      </svg>
      ${systemNodes.map((node) => `<button class="dependency-node internal" type="button" data-node="${escapeHtml(node.id)}" aria-pressed="${node.id === state.selected}" style="left:${pct(node.x, 'x')};top:${pct(node.y, 'y')}"><span class="c4-type">Software System</span><strong>${escapeHtml(titleCase(node.name))}</strong><span class="c4-meta">${graph.edges.filter((edge) => edge.from === node.id || edge.to === node.id).length} relationship(s)</span></button>`).join('')}
      ${externalNodes.map((node) => `<button class="dependency-node external" type="button" data-node="${escapeHtml(node.id)}" aria-pressed="${node.id === state.selected}" style="left:${pct(node.x, 'x')};top:${pct(node.y, 'y')}"><span class="c4-type">External System</span><strong>${escapeHtml(splitPascalCase(node.name))}</strong><span class="c4-meta">${node.members.length} reference(s)</span></button>`).join('')}
    </div>
    ${landscapeDetail(selected, graph)}
  </div>`;
  document.querySelectorAll('[data-node]').forEach((button) => { button.onclick = () => { state.selected = button.dataset.node; renderLandscape(); }; });
  document.querySelectorAll('[data-jump]').forEach((button) => { button.onclick = () => jumpToSource(button.dataset.jump); });
}

function landscapeDetail(node, graph) {
  if (!node) return '';
  const isSystem = node.id.startsWith('sys:');
  const lookup = (id) => graph.systems.find((item) => item.id === id) || graph.externals.find((item) => item.id === id);
  if (isSystem) {
    const outbound = graph.edges.filter((edge) => edge.from === node.id);
    const inbound = graph.edges.filter((edge) => edge.to === node.id);
    const rows = (list, otherKey) => list.map((edge) => {
      const other = lookup(edge[otherKey]);
      return `<tr><td>${escapeHtml(other ? titleCase(other.name) : 'Unknown')}</td><td>${escapeHtml(edgeLabel(edge))}</td><td>${edge.names.length} dependenc${edge.names.length === 1 ? 'y' : 'ies'}</td></tr>`;
    }).join('');
    return `<article class="dependency-detail">
      <p class="eyebrow">Software system</p>
      <h2>${escapeHtml(titleCase(node.name))}</h2>
      <p class="detail-subtitle">${escapeHtml((node.repository || '').replace('https://github.com/', 'github.com/'))}</p>
      <div class="badges"><button class="badge blue as-link" type="button" data-jump="${escapeHtml(node.sourceId)}">View full dependencies →</button></div>
      <h3>Calls out to</h3>${outbound.length ? `<table class="data-table"><thead><tr><th>Target</th><th>Relationship</th><th>Dependencies</th></tr></thead><tbody>${rows(outbound, 'to')}</tbody></table>` : '<p class="muted">No outbound relationships recorded.</p>'}
      <h3>Called by</h3>${inbound.length ? `<table class="data-table"><thead><tr><th>Source</th><th>Relationship</th><th>Dependencies</th></tr></thead><tbody>${rows(inbound, 'from')}</tbody></table>` : '<p class="muted">No inbound relationships recorded.</p>'}
    </article>`;
  }
  return `<article class="dependency-detail">
    <p class="eyebrow">External system</p>
    <h2>${escapeHtml(splitPascalCase(node.name))}</h2>
    <p class="detail-subtitle">Not present in the catalogue — inferred from dependency names that didn't match a cataloged repository.</p>
    <h3>Referenced by</h3>
    <table class="data-table"><thead><tr><th>Source</th><th>Dependency</th><th>Technology</th><th>Confidence</th></tr></thead><tbody>${node.members.map((member) => `<tr><td><button class="as-link" type="button" data-jump="${escapeHtml(member.source.id)}">${escapeHtml(titleCase(member.source.name))}</button></td><td>${escapeHtml(member.dependency.name)}</td><td>${escapeHtml(member.dependency.technology || member.dependency.kind || '—')}</td><td>${escapeHtml(member.dependency.confidence || '—')}</td></tr>`).join('')}</tbody></table>
  </article>`;
}

async function jumpToSource(sourceId) {
  state.mode = 'source';
  applyMode();
  sourceSelect.value = sourceId;
  await selectSource(sourceId);
  if (state.source.capabilities.dependencies) {
    state.view = 'dependencies';
    renderTabs();
    await loadView();
  }
}

function sourceLink(path, scanKind = 'eventcatalog') {
  if (!path) return '<span class="muted">Not recorded</span>';
  const revision = state.source.scans[scanKind]?.['last-commit-hash-scanned'] || state.data.ref || 'HEAD';
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `${state.source.repository.replace(/\/$/, '')}/blob/${encodeURIComponent(revision)}/${encodedPath}`;
  return `<a class="source-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer"><code>${escapeHtml(path)}</code><span aria-hidden="true"> ↗</span><span class="sr-only"> (opens on GitHub)</span></a>`;
}

function operations(spec) {
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
  return Object.entries(spec.paths || {}).flatMap(([path, value]) => methods.filter((method) => value[method]).map((method) => ({ path, method, ...value[method] })));
}

function renderOpenApi(resetToolbar = true) {
  const ops = operations(state.data);
  if (resetToolbar) toolbar.innerHTML = `<label class="source-picker" for="api-file"><span>Specification</span><select id="api-file">${state.source.apiFiles.map((file) => `<option value="${escapeHtml(file)}" ${file === state.apiFile ? 'selected' : ''}>${escapeHtml(file.replace('.openapi.json', ''))}</option>`).join('')}</select></label>${searchControl('Filter paths or operations')}<span class="spacer"></span><span class="toolbar-meta">${ops.length} operations · ${Object.keys(state.data.components?.schemas || {}).length} models</span>`;
  const filtered = ops.filter((op) => `${op.method} ${op.path} ${op.summary} ${(op.tags || []).join(' ')}`.toLowerCase().includes(state.filter));
  if (!state.selected || !filtered.some((op) => `${op.method}:${op.path}` === state.selected)) state.selected = filtered[0] ? `${filtered[0].method}:${filtered[0].path}` : null;
  const selected = ops.find((op) => `${op.method}:${op.path}` === state.selected);
  content.innerHTML = `<div class="split"><aside class="item-list">${filtered.map((op) => `<button class="list-button" type="button" data-operation="${escapeHtml(`${op.method}:${op.path}`)}" aria-current="${state.selected === `${op.method}:${op.path}`}"><span class="list-title"><span class="method ${op.method}">${op.method}</span><span class="endpoint-path">${escapeHtml(op.path)}</span></span><span class="list-meta">${escapeHtml(op.summary || op.operationId || 'No summary')}</span></button>`).join('') || '<div class="detail muted">No matching operations.</div>'}</aside><div class="detail">${selected ? operationDetail(selected) : ''}</div></div>`;
  wireSearch();
  const apiFile = $('#api-file');
  if (apiFile) apiFile.onchange = async (event) => { state.apiFile = event.target.value; state.selected = null; await loadView(); };
  document.querySelectorAll('[data-operation]').forEach((button) => button.addEventListener('click', () => { state.selected = button.dataset.operation; renderOpenApi(false); }));
}

function operationDetail(op) {
  const parameters = op.parameters || [];
  const responses = Object.entries(op.responses || {});
  return `<span class="method ${op.method}">${op.method}</span><h2 class="endpoint-path">${escapeHtml(op.path)}</h2><p class="detail-subtitle">${escapeHtml(op.summary || op.operationId || 'No summary')}</p>
    ${op.description ? `<p>${escapeHtml(op.description)}</p>` : ''}<div class="badges">${(op.tags || []).map((tag) => `<span class="badge blue">${escapeHtml(tag)}</span>`).join('')}</div>
    <h3>Parameters</h3>${parameters.length ? `<table class="data-table"><thead><tr><th>Name</th><th>Location</th><th>Type</th><th>Required</th></tr></thead><tbody>${parameters.map((parameter) => `<tr><td><code>${escapeHtml(parameter.name)}</code></td><td>${escapeHtml(parameter.in)}</td><td>${escapeHtml(schemaLabel(parameter.schema))}</td><td>${parameter.required ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No parameters.</p>'}
    ${requestBody(op.requestBody)}
    <h3>Responses</h3>${responses.length ? `<table class="data-table"><thead><tr><th>Status</th><th>Description</th><th>Schema</th></tr></thead><tbody>${responses.map(([status, response]) => `<tr><td class="response-code">${escapeHtml(status)}</td><td>${escapeHtml(response.description || '—')}</td><td><code>${escapeHtml(contentSchema(response.content))}</code></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No responses documented.</p>'}
    <details><summary>Raw operation JSON</summary><pre>${escapeHtml(JSON.stringify(op, null, 2))}</pre></details>`;
}

function schemaLabel(schema = {}) {
  if (schema.$ref) return schema.$ref.split('/').pop();
  if (schema.type === 'array') return `array<${schemaLabel(schema.items)}>`;
  return [schema.type, schema.format].filter(Boolean).join(' · ') || 'object';
}

function contentSchema(content = {}) {
  const media = content['application/json'] || Object.values(content)[0];
  return media ? schemaLabel(media.schema) : '—';
}

function requestBody(body) {
  if (!body) return '';
  return `<h3>Request body</h3><p><code>${escapeHtml(contentSchema(body.content))}</code>${body.required ? ' <span class="badge amber">required</span>' : ''}</p>`;
}

function renderView(resetToolbar = true) {
  if (state.view === 'database') renderDatabase(resetToolbar);
  if (state.view === 'messages') renderMessages(resetToolbar);
  if (state.view === 'dependencies') renderDependencies();
  if (state.view === 'openapi') renderOpenApi(resetToolbar);
}

tabs.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-view]');
  if (!button || button.disabled || button.dataset.view === state.view) return;
  state.view = button.dataset.view;
  state.selected = null;
  renderTabs();
  await loadView();
});

sourceSelect.addEventListener('change', async () => {
  if (state.mode === 'landscape') { state.mode = 'source'; applyMode(); }
  await selectSource(sourceSelect.value);
});

landscapeToggle.addEventListener('click', async () => {
  state.mode = state.mode === 'landscape' ? 'source' : 'landscape';
  applyMode();
  if (state.mode === 'landscape') {
    setLandscapeHero();
    await loadLandscape();
  } else {
    setHero();
    renderTabs();
    await loadView();
  }
});

async function init() {
  try {
    const catalog = await getJson('/api/catalog');
    state.catalog = catalog.sources;
    if (!state.catalog.length) throw new Error('The manifest does not contain any sources.');
    sourceSelect.innerHTML = state.catalog.map((source) => `<option value="${source.id}">${escapeHtml(titleCase(source.name))}</option>`).join('');
    applyMode();
    await selectSource(state.catalog[0].id);
  } catch (error) {
    content.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

init();
