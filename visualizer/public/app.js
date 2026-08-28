const state = {
  catalog: [], source: null, view: 'database', data: null,
  filter: '', selected: null, messageType: 'all', apiFile: null,
  mode: 'source', landscape: null, apiView: 'operations', selectedModel: null, dbView: 'diagram', cy: null
};

const $ = (selector) => document.querySelector(selector);
const sourceSelect = $('#source-select');
const content = $('#content');
const toolbar = $('#toolbar');
const tabs = $('#view-tabs');
const homeToggle = $('#home-toggle');
const landscapeToggle = $('#landscape-toggle');
const serviceToggle = $('#service-toggle');
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const titleCase = (value) => value.replace(/(^|[-_])(\w)/g, (_, space, char) => `${space ? ' ' : ''}${char.toUpperCase()}`);

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

async function getText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.text();
}

function toHex(text) {
  return Array.from(new TextEncoder().encode(text)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// PlantUML's server expects source compressed with raw deflate then packed 3 bytes -> 4 chars,
// like base64 but with its own alphabet (0-9, A-Z, a-z, -, _). A plain hex-encoded (~h) URL is
// roughly 2x the source size and reliably 400s on any diagram bigger than a toy example, so this
// is required for anything real — not an optimization.
function encode6bit(value) {
  if (value < 10) return String.fromCharCode(48 + value);
  value -= 10;
  if (value < 26) return String.fromCharCode(65 + value);
  value -= 26;
  if (value < 26) return String.fromCharCode(97 + value);
  value -= 26;
  return value === 0 ? '-' : '_';
}

function append3bytes(b1, b2, b3) {
  const c1 = b1 >> 2;
  const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
  const c3 = ((b2 & 0xF) << 2) | (b3 >> 6);
  const c4 = b3 & 0x3F;
  return encode6bit(c1) + encode6bit(c2) + encode6bit(c3) + encode6bit(c4);
}

function encode64(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    if (i + 2 < bytes.length) result += append3bytes(bytes[i], bytes[i + 1], bytes[i + 2]);
    else if (i + 1 < bytes.length) result += append3bytes(bytes[i], bytes[i + 1], 0);
    else result += append3bytes(bytes[i], 0, 0);
  }
  return result;
}

async function encodePlantUml(text) {
  const bytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === 'function') {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
      return encode64(compressed);
    } catch { /* fall through to the hex scheme below */ }
  }
  return `~h${toHex(text)}`;
}

function sourceCapabilities() {
  return [
    { id: 'database', label: 'Data schema', enabled: state.source.capabilities.database },
    { id: 'messages', label: 'Events & commands', enabled: state.source.capabilities.messages },
    { id: 'dependencies', label: 'Dependencies', enabled: state.source.capabilities.dependencies || state.source.capabilities.messages },
    { id: 'openapi', label: 'API specs', enabled: state.source.capabilities.openapi },
    { id: 'localdev', label: 'Local dev', enabled: state.source.capabilities.localdev }
  ];
}

function renderTabs() {
  tabs.innerHTML = sourceCapabilities().map((tab) => `
    <button class="tab" type="button" data-view="${tab.id}" aria-selected="${state.view === tab.id}" ${tab.enabled ? '' : 'disabled'}>
      ${tab.label}${tab.enabled ? '' : '<span class="count">—</span>'}
    </button>`).join('');
}

function setHero() {
  $('#mode-eyebrow').textContent = 'Architecture inventory';
  $('#source-title').textContent = titleCase(state.source.name);
  const link = $('#repo-link');
  link.textContent = state.source.repository.replace('https://github.com/', 'github.com/');
  link.href = state.source.repository;
  const available = sourceCapabilities().filter((tab) => tab.enabled).length;
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
  document.body.dataset.mode = state.mode;
  homeToggle.toggleAttribute('aria-current', state.mode === 'home');
  landscapeToggle.toggleAttribute('aria-current', state.mode === 'landscape');
  serviceToggle.toggleAttribute('aria-current', state.mode === 'source');
}

async function selectSource(id) {
  state.source = state.catalog.find((source) => source.id === id);
  const supportsView = state.view === 'dependencies'
    ? state.source.capabilities.dependencies || state.source.capabilities.messages
    : state.source.capabilities[state.view];
  if (!supportsView) state.view = defaultView();
  state.filter = '';
  state.selected = null;
  state.apiFile = state.source.apiFiles[0] || null;
  setHero();
  renderTabs();
  await loadView();
}

async function loadView() {
  destroyCy();
  toolbar.innerHTML = '';
  content.innerHTML = '<div class="loading">Reading catalogue data…</div>';
  state.filter = '';
  state.selected = null;
  state.selectedModel = null;
  state.diagramPositions = null;
  state.schemaPositions = null;
  state.depView = 'diagram';
  state.pumlSource = null;
  state.pumlEncoded = null;
  try {
    if (state.view === 'dependencies') {
      state.data = await loadDependenciesFor(state.source);
    } else {
      let url = `/api/sources/${encodeURIComponent(state.source.id)}/${state.view}`;
      if (state.view === 'openapi') url += `?file=${encodeURIComponent(state.apiFile)}`;
      state.data = await getJson(url);
    }
    renderView();
  } catch (error) {
    content.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

async function loadDependenciesFor(source) {
  let data = { repository: orgRepoSlug(source.repository), dependencies: [] };
  if (source.capabilities.dependencies) {
    data = await getJson(`/api/sources/${encodeURIComponent(source.id)}/dependencies`);
  }
  if (source.capabilities.messages) {
    try {
      const messages = await getJson(`/api/sources/${encodeURIComponent(source.id)}/messages`);
      data = { ...data, dependencies: [...(data.dependencies || []), ...messageDependencies(source, messages)] };
    } catch { /* messages are supplementary; ignore failures */ }
  }
  return data;
}

function orgRepoSlug(repositoryUrl) {
  return (repositoryUrl || '').replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
}

function namespaceServiceSegment(namespace) {
  const orgPrefixes = new Set(['sfa', 'das']);
  const parts = String(namespace || '').split('.');
  let index = 0;
  while (index < parts.length && orgPrefixes.has(parts[index].toLowerCase())) index++;
  return parts[index] || null;
}

function messageDependencies(source, messages) {
  const events = (messages.events || []).map((m) => ({ ...m, messageKind: 'event' }));
  const commands = (messages.commands || []).map((m) => ({ ...m, messageKind: 'command' }));
  const withHandlers = [...events, ...commands].filter((m) => m.namespace && m.handlers?.length);
  const ownTokens = new Set(tokenize(source.name));
  const groups = new Map();
  for (const message of withHandlers) {
    const segment = namespaceServiceSegment(message.namespace);
    if (!segment) continue;
    const segmentTokens = new Set(tokenize(segment));
    if (canRelate(segmentTokens, ownTokens)) continue;
    const key = segment.toLowerCase();
    if (!groups.has(key)) groups.set(key, { label: segment, tokens: segmentTokens, messages: [] });
    groups.get(key).messages.push(message);
  }
  return [...groups.values()].map((group) => {
    const matchedSystem = state.catalog.find((candidate) => candidate.id !== source.id && canRelate(group.tokens, new Set(tokenize(candidate.name))));
    return {
      name: matchedSystem ? titleCase(matchedSystem.name) : splitPascalCase(group.label),
      kind: 'message',
      classification: matchedSystem ? 'internal' : 'unknown',
      direction: 'inbound',
      client: null,
      technology: 'Event',
      configurationKeys: [],
      authentication: { type: null, configurationKeys: [] },
      operations: group.messages.map((message) => ({ method: message.messageKind === 'command' ? 'COMMAND' : 'EVENT', path: message.name, sourceFile: message.handlers[0]?.sourceFile })),
      resources: [],
      evidence: group.messages.flatMap((message) => message.handlers.map((handler) => ({ sourceFile: handler.sourceFile, reason: `Handles ${message.messageKind} '${message.name}' published under namespace '${message.namespace}'.` }))),
      confidence: 'medium'
    };
  });
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
  const columnCount = tables.reduce((sum, table) => sum + (table.columns?.length || 0), 0);
  if (!state.dbView) state.dbView = 'diagram';
  if (resetToolbar) {
    toolbar.innerHTML = `${searchControl('Filter tables or columns')}<div class="segmented" role="group" aria-label="Schema view"><button data-db-view="diagram" aria-pressed="${state.dbView === 'diagram'}">Diagram</button><button data-db-view="grid" aria-pressed="${state.dbView === 'grid'}">Grid</button></div>${state.dbView === 'diagram' ? diagramControlsHtml() : ''}<span class="spacer"></span><span class="toolbar-meta">${tables.length} tables · ${columnCount} columns · ${relations} relationships</span>`;
    document.querySelectorAll('[data-db-view]').forEach((button) => { button.onclick = () => { state.dbView = button.dataset.dbView; state.filter = ''; state.selected = null; renderDatabase(true); }; });
  }
  const filtered = tables.filter((table) => `${table.schema} ${table.name} ${table.columns?.map((column) => column.name).join(' ')}`.toLowerCase().includes(state.filter));
  if (state.dbView === 'diagram') {
    const { edges, connectedTables, isolatedCount } = databaseGraph(tables);
    renderDatabaseDiagram(connectedTables.filter((table) => filtered.includes(table)), edges, isolatedCount);
  } else {
    destroyCy();
    renderDatabaseGrid(filtered, tables);
  }
  wireSearch();
}

function renderDatabaseGrid(filtered, tables) {
  content.innerHTML = `<div class="schema-grid">${filtered.map((table) => {
    const outbound = table.relationships || [];
    return `<button class="schema-card" type="button" data-table="${escapeHtml(table.name)}">
      <h2>${escapeHtml(table.schema)}.${escapeHtml(table.name)}</h2>
      <p>${table.columns?.length || 0} columns · ${table.indexes?.length || 0} indexes</p>
      <ul class="relation-list">${outbound.slice(0, 3).map((rel) => `<li>→ <strong>${escapeHtml(rel.targetTable)}</strong> via ${escapeHtml(rel.fromColumns?.join(', '))}</li>`).join('')}${outbound.length > 3 ? `<li>+ ${outbound.length - 3} more</li>` : ''}</ul>
    </button>`;
  }).join('')}</div>`;
  if (!filtered.length) content.innerHTML = '<div class="empty-state"><h2>No matching tables</h2><p>Try a different search term.</p></div>';
  document.querySelectorAll('[data-table]').forEach((button) => button.addEventListener('click', () => renderTableDetail(tables.find((table) => table.name === button.dataset.table))));
}

function databaseGraph(tables) {
  const edges = [];
  tables.forEach((table) => {
    (table.relationships || []).forEach((rel) => {
      edges.push({ from: table.name, to: rel.targetTable, fromColumns: rel.fromColumns || [], targetColumns: rel.targetColumns || [], name: rel.name });
    });
  });
  const connectedNames = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const connectedTables = tables.filter((table) => connectedNames.has(table.name));
  return { edges: edges.filter((edge) => connectedNames.has(edge.from) && connectedNames.has(edge.to)), connectedTables, isolatedCount: tables.length - connectedTables.length };
}

function orderTablesForLayout(tables, edges) {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const adjacency = new Map(tables.map((table) => [table.name, new Set()]));
  edges.forEach((edge) => { adjacency.get(edge.from)?.add(edge.to); adjacency.get(edge.to)?.add(edge.from); });
  const degree = (name) => adjacency.get(name)?.size || 0;
  const remaining = new Set(tables.map((table) => table.name));
  const order = [];
  while (remaining.size) {
    const start = [...remaining].sort((a, b) => degree(b) - degree(a))[0];
    const queue = [start];
    remaining.delete(start);
    while (queue.length) {
      const current = queue.shift();
      order.push(byName.get(current));
      const neighbors = [...(adjacency.get(current) || [])].filter((name) => remaining.has(name)).sort((a, b) => degree(b) - degree(a));
      neighbors.forEach((name) => { remaining.delete(name); queue.push(name); });
    }
  }
  return order;
}

function tableRelLabel(edge) {
  const from = edge.fromColumns.join(',');
  const to = edge.targetColumns.join(',');
  return from && to ? `${from} → ${to}` : (edge.name || 'FK');
}

function erNode(table) {
  const height = 48 + Math.max(1, table.columns?.length || 0) * 24;
  return { ...table, id: table.name, width: 274, height };
}

function layoutErNodes(nodes, edges, viewWidth) {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const children = new Map(nodes.map((node) => [node.name, []]));
  const incoming = new Map(nodes.map((node) => [node.name, 0]));
  edges.forEach((edge) => {
    if (!byName.has(edge.from) || !byName.has(edge.to) || edge.from === edge.to) return;
    children.get(edge.to).push(edge.from);
    incoming.set(edge.from, incoming.get(edge.from) + 1);
  });
  const levels = new Map(nodes.map((node) => [node.name, 0]));
  const remaining = new Set(nodes.map((node) => node.name));
  const queue = [...nodes].filter((node) => incoming.get(node.name) === 0).map((node) => node.name).sort();
  while (remaining.size) {
    if (!queue.length) queue.push([...remaining].sort()[0]); // Gracefully place cyclic foreign keys.
    const name = queue.shift();
    if (!remaining.delete(name)) continue;
    children.get(name).forEach((child) => {
      levels.set(child, Math.max(levels.get(child), levels.get(name) + 1));
      incoming.set(child, incoming.get(child) - 1);
      if (incoming.get(child) <= 0) queue.push(child);
    });
    queue.sort();
  }
  const rows = new Map();
  nodes.forEach((node) => {
    const level = levels.get(node.name);
    if (!rows.has(level)) rows.set(level, []);
    rows.get(level).push(node);
  });
  const positions = new Map();
  const rowEntries = [...rows.entries()].sort(([a], [b]) => a - b);
  let y = 80;
  rowEntries.forEach(([, row]) => {
    row.sort((a, b) => a.name.localeCompare(b.name));
    const rowHeight = Math.max(...row.map((node) => node.height));
    row.forEach((node, index) => positions.set(node.name, {
      x: (index + 0.5) * viewWidth / row.length,
      y: y + rowHeight / 2
    }));
    y += rowHeight + 180;
  });
  return nodes.map((node) => ({ ...node, ...positions.get(node.name) }));
}

function renderDatabaseDiagram(filtered, allEdges, isolatedCount) {
  const edges = allEdges.filter((edge) => filtered.some((table) => table.name === edge.from) && filtered.some((table) => table.name === edge.to));
  if (!filtered.length) {
    destroyCy();
    content.innerHTML = '<div class="empty-state"><h2>No matching tables with relationships</h2><p>Try a different search term, or switch to Grid to see every table.</p></div>';
    return;
  }
  const ordered = orderTablesForLayout(filtered, edges);
  const nodes = ordered.map(erNode);
  const levelEstimate = Math.max(2, Math.ceil(Math.sqrt(nodes.length)));
  const viewWidth = Math.max(1100, levelEstimate * 380);
  const positioned = layoutErNodes(nodes, edges, viewWidth);
  if (!state.schemaPositions) state.schemaPositions = new Map();
  const positions = state.schemaPositions;
  positioned.forEach((node) => positionFor(positions, node.name, node));
  if (!state.selected || !filtered.some((table) => table.name === state.selected)) state.selected = positioned[0]?.name || null;
  const selectedTable = filtered.find((table) => table.name === state.selected);

  const elements = [
    ...positioned.map((node) => {
      const foreignKeys = new Set((node.relationships || []).flatMap((relationship) => relationship.fromColumns || []));
      return {
        data: {
          id: node.name, isLeaf: true, width: node.width, height: node.height, schema: node.schema, name: node.name,
          columns: (node.columns || []).map((column) => ({ name: column.name, type: column.type || '', flag: column.primaryKey ? 'PK' : (foreignKeys.has(column.name) ? 'FK' : '') }))
        },
        position: positions.get(node.name)
      };
    }),
    ...edges.map((edge, index) => ({ data: { id: `schema-edge-${index}`, source: edge.from, target: edge.to, label: tableRelLabel(edge) } }))
  ];

  content.innerHTML = `<div class="dependency-view">
    ${isolatedCount ? `<p class="toolbar-meta">${isolatedCount} table${isolatedCount === 1 ? '' : 's'} with no foreign keys — switch to Grid to browse them.</p>` : ''}
    <div id="erd-cy" class="cy-container" role="group" aria-label="Database relationship diagram"></div>
    <div id="erd-detail">${selectedTable ? tableDetailInline(selectedTable) : ''}</div>
  </div>`;

  mountCy({
    container: $('#erd-cy'),
    elements,
    layout: { name: 'preset' },
    htmlLabels: [{
      query: 'node[?isLeaf]',
      halign: 'center', valign: 'center', halignBox: 'center', valignBox: 'center',
      tpl: (data) => `<div class="cy-er-node" data-node-id="${escapeHtml(data.id)}">
        <span class="er-table"><span>${escapeHtml(data.schema)}</span>${escapeHtml(data.name)}</span>
        <span class="er-columns">${(data.columns || []).map((column) => `<span class="er-column"><b>${escapeHtml(column.flag)}</b><code>${escapeHtml(column.name)}</code><em>${escapeHtml(column.type)}</em></span>`).join('') || '<span class="er-column muted">No columns recorded</span>'}</span>
      </div>`
    }],
    onTapNode: (node) => {
      state.selected = node.id();
      markCySelection($('#erd-cy'), state.selected);
      $('#erd-detail').innerHTML = tableDetailInline(filtered.find((table) => table.name === state.selected));
    },
    onDragFree: (node) => { positions.set(node.id(), node.position()); }
  });
  markCySelection($('#erd-cy'), state.selected);
  wireDiagramControls(() => { positions.clear(); renderDatabase(false); });
}

function tableDetailInline(table) {
  const incoming = (state.data.tables || []).flatMap((candidate) => (candidate.relationships || [])
    .filter((relation) => relation.targetTable === table.name)
    .map((relation) => ({ ...relation, fromTable: candidate.name })));
  return `<article class="dependency-detail">
    <p class="eyebrow">${escapeHtml(table.schema)} schema</p><h2>${escapeHtml(table.name)}</h2>
    <div class="badges"><span class="badge">${table.columns.length} columns</span><span class="badge blue">${table.indexes?.length || 0} indexes</span><span class="badge amber">${(table.relationships?.length || 0) + incoming.length} links</span></div>
    <h3>Columns</h3>${columnsTable(table.columns)}
    <h3>Relationships</h3>${relationshipsTable(table.relationships || [], incoming)}
    <h3>Indexes</h3>${indexesTable(table.indexes || [])}
  </article>`;
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

function mergeDependencyGroup(id, members) {
  const first = members[0];
  const unique = (values) => [...new Set(values.filter(Boolean))];
  const directions = unique(members.map((member) => member.direction));
  const technologies = unique(members.map((member) => member.technology));
  const clients = unique(members.map((member) => member.client));
  const authTypes = unique(members.map((member) => member.authentication?.type));
  return {
    ...first,
    id,
    direction: directions.length === 1 ? directions[0] : 'mixed',
    technology: technologies.join(' / ') || null,
    client: clients.join(' / ') || null,
    authentication: {
      type: authTypes.join(' / ') || null,
      configurationKeys: unique(members.flatMap((member) => member.authentication?.configurationKeys || []))
    },
    configurationKeys: unique(members.flatMap((member) => member.configurationKeys || [])),
    operations: members.flatMap((member) => member.operations || []),
    resources: members.flatMap((member) => member.resources || []),
    evidence: members.flatMap((member) => member.evidence || []),
    members
  };
}

function usesRedis(dependency) {
  const haystack = [
    dependency.name, dependency.technology, dependency.client, dependency.kind,
    ...(dependency.configurationKeys || []),
    ...((dependency.resources || []).flatMap((resource) => [resource.type, resource.name, resource.kind]))
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes('redis');
}

function orgName(repository) {
  return (repository || '').split('/')[0] || 'System';
}

function orgFromRepoUrl(url) {
  return (url || '').replace(/^https?:\/\/[^/]+\//, '').split('/')[0] || 'System';
}

function relationshipLabel(dependency) {
  const verb = dependency.description || (dependency.direction === 'inbound' ? 'Called by' : 'Calls');
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
  const verb = edge.kinds.includes('message') && !edge.kinds.includes('http-api') ? 'Publishes to' : 'Calls';
  return `${verb}${technology ? ` [${technology}]` : ''}${edge.count > 1 ? ` ×${edge.count}` : ''}`;
}

function buildLandscape(sources, dependencySets) {
  const systemTokenMap = new Map(sources.map((s) => [s.id, new Set(tokenize(s.name))]));
  const edgeMap = new Map();

  function addEdge(from, to, dependency, reference) {
    const key = `${from}|${to}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { from, to, count: 0, operations: 0, technologies: new Set(), names: new Set(), kinds: new Set(), references: [], isRedis: false });
    const edge = edgeMap.get(key);
    edge.count += 1;
    edge.operations += dependency.operations?.length || 0;
    const kindLabel = dependency.kind === 'http-api' ? 'HTTP' : dependency.kind;
    [kindLabel, dependency.technology].filter(Boolean).forEach((value) => edge.technologies.add(value));
    edge.names.add(dependency.name);
    if (dependency.kind) edge.kinds.add(dependency.kind);
    if (reference) edge.references.push(reference);
    if (usesRedis(dependency)) edge.isRedis = true;
  }

  const externalEntries = [];
  for (const { source, dependencies } of dependencySets) {
    const ownTokens = systemTokenMap.get(source.id);
    for (const [dependencyIndex, dependency] of dependencies.entries()) {
      const depTokens = new Set(tokenize(dependency.name));
      if (canRelate(depTokens, ownTokens)) continue;
      const matchedSystem = sources.find((candidate) => candidate.id !== source.id && canRelate(depTokens, systemTokenMap.get(candidate.id)));
      if (matchedSystem) {
        const [from, to] = dependency.direction === 'inbound' ? [`sys:${matchedSystem.id}`, `sys:${source.id}`] : [`sys:${source.id}`, `sys:${matchedSystem.id}`];
        addEdge(from, to, dependency, { sourceId: source.id, dependencyIndex });
        continue;
      }
      if (depTokens.size === 0) continue;
      externalEntries.push({ source, dependency, dependencyIndex, tokens: depTokens });
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
    const isRedis = members.some((member) => usesRedis(member.dependency));
    members.forEach((member) => {
      const [from, to] = member.dependency.direction === 'inbound' ? [id, `sys:${member.source.id}`] : [`sys:${member.source.id}`, id];
      addEdge(from, to, member.dependency, { sourceId: member.source.id, dependencyIndex: member.dependencyIndex });
    });
    externals.push({ id, name, members, isRedis });
  }

  const systems = sources.map((s) => ({ id: `sys:${s.id}`, sourceId: s.id, name: s.name, repository: s.repository }));
  const edges = [...edgeMap.values()].map((edge) => ({ ...edge, technologies: [...edge.technologies], names: [...edge.names], kinds: [...edge.kinds] }));
  return { systems, externals, edges };
}

function ringLayout(group, center, radiusX, radiusY, angleOffset = 0) {
  return group.map((dependency, index) => {
    const angle = (Math.PI * 2 * index / group.length) - Math.PI / 2 + angleOffset;
    return { ...dependency, x: center.x + Math.cos(angle) * radiusX, y: center.y + Math.sin(angle) * radiusY };
  });
}

function positionFor(positions, id, computed) {
  if (!positions.has(id)) positions.set(id, { x: computed.x, y: computed.y });
  return positions.get(id);
}

function destroyCy() {
  if (state.cy) {
    try { state.cy.destroy(); } catch { /* already gone */ }
    state.cy = null;
  }
}

const CY_STYLE = [
  { selector: 'node', style: { 'background-opacity': 0, 'border-width': 0, 'label': '', 'shape': 'round-rectangle', 'width': 'data(width)', 'height': 'data(height)' } },
  { selector: 'node:parent', style: {
      'background-color': '#5ce1b9', 'background-opacity': 0.06,
      'border-width': 1.5, 'border-style': 'dashed', 'border-color': '#56645f', 'border-opacity': 1,
      'label': 'data(label)', 'color': '#8fa69d', 'text-valign': 'top', 'text-halign': 'left',
      'font-size': 11, 'text-margin-y': -10, 'text-margin-x': 10, 'padding': '46px'
  } },
  { selector: 'edge', style: {
      'width': 2, 'line-color': '#42685b', 'target-arrow-color': '#42685b', 'target-arrow-shape': 'triangle',
      'arrow-scale': 1.1, 'curve-style': 'bezier', 'text-rotation': 'autorotate',
      'label': 'data(label)', 'font-size': 10, 'color': '#8fa69d',
      'text-background-color': '#08110f', 'text-background-opacity': 0.9, 'text-background-padding': '3px', 'text-background-shape': 'roundrectangle'
  } },
  { selector: 'edge.inbound', style: { 'line-color': '#7db7ff', 'target-arrow-color': '#7db7ff' } },
  { selector: 'edge.jumpable', style: { 'line-style': 'solid', 'width': 2.5 } },
  { selector: 'edge.redis', style: { 'line-color': '#ff8f8f', 'target-arrow-color': '#ff8f8f' } }
];

function mountCy({ container, elements, layout, htmlLabels, onTapNode, onTapEdge, onDragFree }) {
  destroyCy();
  const cy = cytoscape({ container, elements, style: CY_STYLE, layout, wheelSensitivity: 0.25, minZoom: 0.15, maxZoom: 3 });
  if (htmlLabels) cy.nodeHtmlLabel(htmlLabels);
  if (onTapNode) cy.on('tap', 'node', (event) => { if (!event.target.isParent()) onTapNode(event.target); });
  if (onTapEdge) cy.on('tap', 'edge', (event) => onTapEdge(event.target));
  if (onDragFree) cy.on('dragfree', 'node', (event) => onDragFree(event.target));
  state.cy = cy;
  return cy;
}

function markCySelection(containerEl, selectedId) {
  containerEl?.querySelectorAll('[data-node-id]').forEach((el) => {
    el.classList.toggle('selected', el.dataset.nodeId === selectedId);
  });
}

function wireNodeHoverTooltip(cy, container, buildContent) {
  if (!cy || !container) return;
  let tooltip = null;
  let hideTimer = null;

  function ensureTooltip() {
    if (tooltip) return tooltip;
    tooltip = document.createElement('div');
    tooltip.className = 'node-tooltip';
    tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    tooltip.addEventListener('mouseleave', scheduleHide);
    document.body.appendChild(tooltip);
    return tooltip;
  }

  function positionTooltip(node) {
    const rect = container.getBoundingClientRect();
    const pos = node.renderedPosition();
    const halfHeight = (node.renderedHeight ? node.renderedHeight() : 48) / 2;
    const spaceAbove = rect.top + pos.y - halfHeight;
    tooltip.style.left = `${rect.left + pos.x}px`;
    if (spaceAbove < 160) {
      tooltip.style.top = `${rect.top + pos.y + halfHeight + 10}px`;
      tooltip.style.transform = 'translate(-50%, 0)';
    } else {
      tooltip.style.top = `${spaceAbove - 10}px`;
      tooltip.style.transform = 'translate(-50%, -100%)';
    }
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (tooltip) tooltip.style.display = 'none'; }, 150);
  }

  cy.on('mouseover', 'node', (event) => {
    const node = event.target;
    if (node.isParent()) return;
    const html = buildContent(node);
    if (!html) return;
    clearTimeout(hideTimer);
    ensureTooltip().innerHTML = html;
    positionTooltip(node);
    tooltip.style.display = 'block';
  });
  cy.on('mouseout', 'node', scheduleHide);
  cy.on('pan zoom drag', () => { if (tooltip) tooltip.style.display = 'none'; });
  cy.on('destroy', () => { tooltip?.remove(); tooltip = null; });
  // Cytoscape's synthetic node mouseout doesn't reliably fire when the pointer leaves the
  // canvas entirely (only when moving to another node or empty canvas space), so back it
  // with a native DOM listener on the container itself.
  container.addEventListener('mouseleave', scheduleHide);
}

function diagramControlsHtml() {
  return `<button id="auto-arrange" class="plain-button" type="button">Auto arrange</button><div class="diagram-zoom" role="group" aria-label="Diagram zoom"><button id="zoom-out" type="button" aria-label="Zoom out">−</button><button id="zoom-fit" type="button">Fit</button><button id="zoom-in" type="button" aria-label="Zoom in">+</button></div>`;
}

function wireDiagramControls(onAutoArrange) {
  const zoomOut = $('#zoom-out'), zoomIn = $('#zoom-in'), zoomFit = $('#zoom-fit'), autoArrange = $('#auto-arrange');
  if (zoomOut) zoomOut.onclick = () => { const cy = state.cy; if (cy) cy.zoom({ level: Math.max(cy.minZoom(), cy.zoom() / 1.25), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }); };
  if (zoomIn) zoomIn.onclick = () => { const cy = state.cy; if (cy) cy.zoom({ level: Math.min(cy.maxZoom(), cy.zoom() * 1.25), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }); };
  if (zoomFit) zoomFit.onclick = () => { state.cy?.fit(undefined, 40); };
  if (autoArrange) autoArrange.onclick = () => onAutoArrange();
}

function depViewToggleHtml() {
  return `<div class="segmented" role="group" aria-label="Dependency view">
    <button data-dep-view="diagram" aria-pressed="${state.depView === 'diagram'}">Diagram</button>
    <button data-dep-view="puml" aria-pressed="${state.depView === 'puml'}">PlantUML source</button>
    <button data-dep-view="puml-live" aria-pressed="${state.depView === 'puml-live'}">Live PlantUML</button>
  </div>`;
}

function wireDepViewToggle() {
  document.querySelectorAll('[data-dep-view]').forEach((button) => {
    button.onclick = async () => {
      state.depView = button.dataset.depView;
      if (state.depView !== 'diagram' && state.pumlEncoded === null) {
        destroyCy();
        content.innerHTML = '<div class="loading">Loading PlantUML source…</div>';
        try {
          state.pumlSource = await getText(`/api/sources/${encodeURIComponent(state.source.id)}/dependency-diagram`);
          state.pumlEncoded = await encodePlantUml(state.pumlSource);
        } catch (error) {
          content.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
          return;
        }
      }
      renderDependencies(true);
    };
  });
}

function pumlUrls(encoded) {
  return {
    svg: `https://www.plantuml.com/plantuml/svg/${encoded}`,
    edit: `https://www.plantuml.com/plantuml/uml/${encoded}`
  };
}

function pumlSourceView(source, encoded) {
  const { svg, edit } = pumlUrls(encoded);
  return `<div class="dependency-view">
    <p class="toolbar-meta">Generated C4 PlantUML source for this service. Rendering it sends this text to the public PlantUML server at plantuml.com — nothing is sent unless you open one of the links below.</p>
    <div class="puml-actions"><a class="plain-button" href="${svg}" target="_blank" rel="noopener noreferrer">Render diagram on plantuml.com ↗</a><a class="plain-button" href="${edit}" target="_blank" rel="noopener noreferrer">Open in PlantUML editor ↗</a></div>
    <pre class="puml-source"><code>${escapeHtml(source)}</code></pre>
  </div>`;
}

function pumlLiveView(source, encoded) {
  const { svg, edit } = pumlUrls(encoded);
  return `<div class="dependency-view">
    <p class="toolbar-meta">Live C4 diagram rendered by the public PlantUML server at plantuml.com from the generated source below — the source is sent there automatically to produce this image.</p>
    <div class="puml-render-wrap">
      <a href="${svg}" target="_blank" rel="noopener noreferrer" title="Open full-size"><img class="puml-render" src="${svg}" alt="Live PlantUML C4 diagram for ${escapeHtml(titleCase(state.source.name))}" onerror="this.closest('.puml-render-wrap').classList.add('puml-render-error')"></a>
      <p class="puml-render-fallback muted">Couldn't reach the PlantUML server. <a class="plain-button" href="${edit}" target="_blank" rel="noopener noreferrer">Open in PlantUML editor ↗</a></p>
    </div>
    <details class="puml-source-details">
      <summary>View PlantUML source</summary>
      <pre class="puml-source"><code>${escapeHtml(source)}</code></pre>
    </details>
  </div>`;
}

function renderDependencies(resetToolbar = true) {
  const hasDiagramSource = state.source.capabilities.dependencyDiagram;
  if (!state.depView) state.depView = 'diagram';
  if (resetToolbar && state.depView !== 'diagram') {
    toolbar.innerHTML = `${depViewToggleHtml()}`;
    wireDepViewToggle();
  }
  if (state.depView !== 'diagram') {
    destroyCy();
    const view = state.depView === 'puml-live' ? pumlLiveView : pumlSourceView;
    content.innerHTML = state.pumlSource ? view(state.pumlSource, state.pumlEncoded) : '<div class="empty-state"><h2>PlantUML diagram unavailable</h2></div>';
    return;
  }

  // Multi-container services (see the containers block below) report the same downstream
  // dependency once per container that calls it — e.g. six containers all reading the same
  // database yields six near-identical "Provider Commitments Database" entries. Group by
  // targetId (or kind+name when there's none, e.g. message-based entries) into one node per
  // real dependency, keeping every raw entry so a dedicated edge is still drawn from each
  // container that actually uses it.
  const rawDependencies = state.data.dependencies || [];
  const targetKeyFor = (dependency) => dependency.targetId || `${dependency.kind || 'dependency'}:${dependency.name}`;
  const dependencyGroups = new Map();
  rawDependencies.forEach((dependency) => {
    const key = targetKeyFor(dependency);
    if (!dependencyGroups.has(key)) dependencyGroups.set(key, []);
    dependencyGroups.get(key).push(dependency);
  });
  const dependencies = [...dependencyGroups.entries()].map(([id, members]) => mergeDependencyGroup(id, members));
  const operations = dependencies.reduce((sum, dependency) => sum + (dependency.operations?.length || 0), 0);
  const internalCount = dependencies.filter((dependency) => dependency.classification === 'internal').length;
  const messageCount = dependencies.filter((dependency) => dependency.kind === 'message').length;
  const redisCount = dependencies.filter(usesRedis).length;
  if (resetToolbar) {
    toolbar.innerHTML = `${searchControl('Filter dependencies')}${hasDiagramSource ? depViewToggleHtml() : ''}${diagramControlsHtml()}<span class="spacer"></span><span class="toolbar-meta">${dependencies.length} dependencies · ${internalCount} internal · ${dependencies.length - internalCount} external · ${messageCount} message-based${redisCount ? ` · ${redisCount} using Redis` : ''} · ${operations} operations</span>`;
    if (hasDiagramSource) wireDepViewToggle();
  }
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
  const VIEW_W = 1400, VIEW_H = 800;
  const center = { x: VIEW_W / 2, y: VIEW_H / 2 };
  const nodeHalfW = 98, nodeHalfH = 48, pad = 26;

  // The commitments-style schema is the pattern being adopted for every service: a top-level
  // `containers` array plus `sourceId` on each dependency pointing at the container it came
  // from. Only that top-level array is used to draw the C4 boxes — older sources without it
  // fall back to a single node representing the whole service, as before. A multi-container
  // service needs its own ring, sized so the boxes don't overlap each other, and the
  // dependency ring around it pushed out so it clears that cluster.
  const topLevelContainers = state.data.containers || [];
  const hasContainers = topLevelContainers.length > 0;
  const containerBoxHalfW = 105, containerBoxHalfH = 49, containerGap = 40;
  const multiContainer = topLevelContainers.length > 1;
  const containerRadius = multiContainer
    ? Math.max(180, (containerBoxHalfW * 2 + containerGap) / (2 * Math.sin(Math.PI / topLevelContainers.length)))
    : 0;
  const containerClearance = multiContainer ? containerRadius + containerBoxHalfH + nodeHalfH + pad : 0;
  const internalRx = 270 + containerClearance, internalRy = 150 + containerClearance;
  const boundaryRx = internalRx + nodeHalfW + pad;
  const boundaryRy = internalRy + nodeHalfH + pad;
  const externalScale = 1.4;
  const internal = ringLayout(filtered.filter((d) => d.classification === 'internal'), center, internalRx, internalRy, 0);
  const external = ringLayout(filtered.filter((d) => d.classification !== 'internal'), center, boundaryRx * externalScale, boundaryRy * externalScale, Math.PI / 5);
  const nodes = [...internal, ...external];
  if (!state.diagramPositions) state.diagramPositions = new Map();
  const positions = state.diagramPositions;

  const containerNodes = hasContainers
    ? (multiContainer ? ringLayout(topLevelContainers, center, containerRadius, containerRadius, 0) : [{ ...topLevelContainers[0], x: center.x, y: center.y }])
    : [{ id: 'center', name: state.source.name, x: center.x, y: center.y }];
  const containerIds = new Set(containerNodes.map((node) => node.id));
  containerNodes.forEach((node) => positionFor(positions, node.id, node));
  nodes.forEach((node) => positionFor(positions, node.id, node));
  const containerIdFor = (dependency) => (containerIds.has(dependency.sourceId) ? dependency.sourceId : containerNodes[0].id);

  const orgLabel = orgName(state.data.repository);
  const elements = [
    { data: { id: 'boundary', label: orgLabel.toUpperCase() } },
    ...containerNodes.map((node) => ({
      data: {
        id: node.id, parent: 'boundary', isLeaf: true, isContainer: true, isSystem: !hasContainers,
        width: 210, height: 98, label: hasContainers ? titleCase(node.name) : titleCase(state.source.name),
        containerType: node.type
      },
      position: positions.get(node.id)
    })),
    ...nodes.map((node) => ({
      data: {
        id: node.id, isLeaf: true, width: 196, height: 96,
        ...(node.classification === 'internal' ? { parent: 'boundary' } : {}),
        kind: node.kind, classification: node.classification, name: node.name,
        technology: node.technology, opsCount: node.operations?.length || 0, isRedis: usesRedis(node)
      },
      position: positions.get(node.id)
    })),
    // One edge per original entry (per container that actually depends on it), not per merged
    // node — that's what shows the fan-in when several containers share the same dependency.
    ...nodes.flatMap((node) => node.members.map((member, memberIndex) => {
      const inbound = member.direction === 'inbound';
      const containerId = containerIdFor(member);
      return { data: { id: `edge-${node.id}-${memberIndex}`, source: inbound ? node.id : containerId, target: inbound ? containerId : node.id, label: relationshipLabel(member) }, classes: inbound ? 'inbound' : '' };
    }))
  ];

  content.innerHTML = `<div class="dependency-view">
    <div class="c4-legend">
      <span class="c4-legend-item"><span class="c4-swatch focus"></span>${hasContainers ? 'Container (this service)' : 'Software system (this service)'}</span>
      <span class="c4-legend-item"><span class="c4-swatch internal"></span>Container — internal</span>
      <span class="c4-legend-item"><span class="c4-swatch external"></span>External system</span>
      <span class="c4-legend-item"><span class="c4-swatch cache"></span>Uses Redis</span>
      <span class="c4-legend-item"><span class="c4-boundary-swatch"></span>${escapeHtml(orgLabel)} system boundary</span>
      <span class="c4-legend-item">Drag to rearrange · scroll to zoom · drag background to pan</span>
    </div>
    <div id="dep-cy" class="cy-container" role="group" aria-label="C4 container diagram for ${escapeHtml(titleCase(state.source.name))}"></div>
    <div id="dep-detail">${dependencyDetail(dependencies.find((item) => item.id === state.selected))}</div>
  </div>`;
  wireSearch();

  const cy = mountCy({
    container: $('#dep-cy'),
    elements,
    layout: { name: 'preset' },
    htmlLabels: [{
      query: 'node[?isLeaf]',
      halign: 'center', valign: 'center', halignBox: 'center', valignBox: 'center',
      tpl: (data) => {
        if (data.isContainer) {
          const typeLabel = data.isSystem ? 'Software System' : `Container${data.containerType ? ` · ${escapeHtml(titleCase(data.containerType))}` : ''}`;
          return `<div class="cy-node service-node" data-node-id="${escapeHtml(data.id)}"><span class="c4-type">${typeLabel}</span><strong>${escapeHtml(data.label)}</strong></div>`;
        }
        const nodeClass = data.isRedis ? 'cache' : (data.kind === 'message' ? 'message' : (data.classification === 'internal' ? 'internal' : 'external'));
        const typeLabel = data.classification === 'internal' ? 'Container' : 'External System';
        const alreadyMentionsRedis = (data.technology || '').toLowerCase().includes('redis');
        return `<div class="cy-node ${nodeClass}" data-node-id="${escapeHtml(data.id)}"><span class="c4-type">${escapeHtml(typeLabel)}</span><strong>${escapeHtml(splitPascalCase(data.name))}</strong><span class="c4-meta">${escapeHtml(data.technology || data.kind || 'service')} · ${data.opsCount} op${data.opsCount === 1 ? '' : 's'}${data.isRedis && !alreadyMentionsRedis ? ' · Redis' : ''}</span></div>`;
      }
    }],
    onTapNode: (node) => {
      if (containerIds.has(node.id())) return;
      state.selected = node.id();
      markCySelection($('#dep-cy'), state.selected);
      $('#dep-detail').innerHTML = dependencyDetail(dependencies.find((item) => item.id === state.selected));
    },
    onDragFree: (node) => { positions.set(node.id(), node.position()); }
  });
  markCySelection($('#dep-cy'), state.selected);
  wireDiagramControls(() => { positions.clear(); renderDependencies(false); });
  wireNodeHoverTooltip(cy, $('#dep-cy'), (node) => {
    if (node.id() === 'center') return null;
    const dependency = dependencies.find((item) => item.id === node.id());
    return dependency ? dependencyTooltipContent(dependency) : null;
  });
}

function dependencyDetail(dependency) {
  const authentication = dependency.authentication || {};
  const scanKind = dependency.kind === 'message' ? 'eventcatalog' : 'service-dependencies';
  const facts = [
    dependency.description ? ['Relationship', dependency.description] : null,
    ['Type', c4Type(dependency)],
    ['Client', dependency.client],
    ['Technology', dependency.technology],
    ['Authentication', authentication.type],
    ['Confidence', dependency.confidence]
  ].filter(Boolean);
  return `<article class="dependency-detail">
    <p class="eyebrow">${escapeHtml(dependency.direction || 'Unknown')} dependency</p>
    <h2>${escapeHtml(dependency.name)}</h2>
    <div class="badges"><span class="badge blue">${escapeHtml(dependency.kind || 'service')}</span><span class="badge ${dependency.classification === 'unknown' ? 'amber' : ''}">${escapeHtml(dependency.classification || 'unknown')}</span>${usesRedis(dependency) ? '<span class="badge danger">Redis</span>' : ''}</div>
    <dl class="dependency-facts">${facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value || 'Not recorded')}</dd></div>`).join('')}</dl>
    <h3>Operations</h3>${dependencyOperations(dependency.operations || [], scanKind)}
    <h3>Configuration</h3>${dependencyKeys([...(dependency.configurationKeys || []), ...(authentication.configurationKeys || [])])}
    ${(dependency.resources || []).length ? `<h3>Resources</h3>${dependencyResources(dependency.resources)}` : ''}
    <h3>Evidence</h3>${dependencyEvidence(dependency.evidence || [], scanKind)}
  </article>`;
}

function dependencyOperations(operations, scanKind = 'service-dependencies') {
  if (!operations.length) return '<p class="muted">No operations recorded.</p>';
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Method</th><th>Path</th><th>Source</th></tr></thead><tbody>${operations.map((operation) => `<tr><td><span class="method ${escapeHtml((operation.method || '').toLowerCase())}">${escapeHtml(operation.methodName || operation.method || '—')}</span></td><td><code>${escapeHtml(operation.path || 'Not resolved')}</code></td><td>${sourceLink(operation.sourceFile, scanKind)}</td></tr>`).join('')}</tbody></table></div>`;
}

function dependencyKeys(keys) {
  const unique = [...new Set(keys)].sort((a, b) => a.localeCompare(b));
  return unique.length ? `<ul class="code-list">${unique.map((key) => `<li><code>${escapeHtml(key)}</code></li>`).join('')}</ul>` : '<p class="muted">No configuration keys recorded.</p>';
}

function dependencyResources(resources) {
  return `<table class="data-table"><thead><tr><th>Name</th><th>Type</th></tr></thead><tbody>${resources.map((resource) => `<tr><td>${escapeHtml(resource.name || resource.path || 'Unnamed')}</td><td>${escapeHtml(resource.type || resource.kind || 'Not recorded')}</td></tr>`).join('')}</tbody></table>`;
}

function dependencyEvidence(evidence, scanKind = 'service-dependencies') {
  if (!evidence.length) return '<p class="muted">No source evidence recorded.</p>';
  return `<ol class="evidence-list">${evidence.map((item) => `<li><p>${escapeHtml(item.reason || 'Dependency reference')}</p>${sourceLink(item.sourceFile, scanKind)}</li>`).join('')}</ol>`;
}

function setLandscapeHero() {
  $('#mode-eyebrow').textContent = 'Architecture inventory';
  $('#source-title').textContent = 'System landscape';
  $('#source-stats').innerHTML = '';
}

function setHomeHero() {
  $('#mode-eyebrow').textContent = 'Service catalogue';
  $('#source-title').textContent = 'Dashboard';
  $('#source-stats').innerHTML = '';
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

function severityClass(severity) {
  return SEVERITY_ORDER.includes(severity) ? severity : 'unknown';
}

function sortedSeverities(counts) {
  return Object.keys(counts).filter((severity) => counts[severity] > 0).sort((a, b) => severityRank(a) - severityRank(b) || a.localeCompare(b));
}

function severityPills(counts) {
  return sortedSeverities(counts).map((severity) => `<span class="severity-pill ${severityClass(severity)}">${counts[severity]} ${escapeHtml(severity)}</span>`).join('');
}

async function loadHomeDashboard() {
  destroyCy();
  toolbar.innerHTML = '';
  content.innerHTML = '<div class="loading">Reading catalogue data…</div>';
  state.selected = null;
  try {
    state.securityAudit = await Promise.all(state.catalog.map(async (source) => {
      if (!source.capabilities.security) return { source, alerts: null };
      try {
        return { source, alerts: await getJson(`/api/sources/${encodeURIComponent(source.id)}/security`) };
      } catch {
        return { source, alerts: null };
      }
    }));
    renderHomeDashboard();
  } catch (error) {
    content.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

function renderHomeDashboard() {
  const results = state.securityAudit || [];
  const scanned = results.filter((result) => result.alerts);
  const totalOpen = scanned.reduce((sum, result) => sum + (result.alerts.openCount || 0), 0);
  const totalSeverityCounts = {};
  scanned.forEach((result) => {
    Object.entries(result.alerts.severityCounts || {}).forEach(([severity, count]) => {
      totalSeverityCounts[severity] = (totalSeverityCounts[severity] || 0) + count;
    });
  });
  const affectedCount = scanned.filter((result) => (result.alerts.openCount || 0) > 0).length;
  const worstSeverity = sortedSeverities(totalSeverityCounts)[0];

  $('#source-stats').innerHTML = `
    <div class="stat"><dt>Repos scanned</dt><dd>${scanned.length}/${results.length}</dd></div>
    <div class="stat"><dt>Open alerts</dt><dd>${totalOpen}</dd></div>
    <div class="stat"><dt>Repos affected</dt><dd>${affectedCount}</dd></div>
    <div class="stat"><dt>Highest severity</dt><dd>${worstSeverity ? titleCase(worstSeverity) : '—'}</dd></div>`;

  toolbar.innerHTML = '<span class="toolbar-meta">Dependabot alert data generated per repository — click a row for the full alert list.</span>';

  const rows = [...results].sort((a, b) => (b.alerts?.openCount || 0) - (a.alerts?.openCount || 0));

  content.innerHTML = `<div class="dashboard">
    <section class="dashboard-section">
      <h2>Security audit</h2>
      <p class="section-sub">Open Dependabot alerts across ${results.length} cataloged repositories.</p>
      ${totalOpen ? `<div class="severity-summary">${severityPills(totalSeverityCounts)}</div>` : ''}
      <div class="table-wrap">
        <table class="data-table repo-alert-table">
          <thead><tr><th>Repository</th><th>Open alerts</th><th>Severity</th><th>Last scanned</th></tr></thead>
          <tbody>${rows.map(repoAlertRows).join('')}</tbody>
        </table>
      </div>
    </section>
  </div>`;

  document.querySelectorAll('[data-toggle-alerts]').forEach((row) => {
    row.addEventListener('click', () => {
      const detail = document.querySelector(`[data-detail-for="${row.dataset.toggleAlerts}"]`);
      if (detail) detail.hidden = !detail.hidden;
    });
  });
}

function repoAlertRows({ source, alerts }) {
  const openCount = alerts?.openCount || 0;
  const generatedAt = alerts?.generatedAt ? new Date(alerts.generatedAt).toLocaleDateString() : '—';
  const severity = alerts ? (severityPills(alerts.severityCounts || {}) || '<span class="muted">None</span>') : '';
  const summaryRow = `<tr class="repo-alert-row" data-toggle-alerts="${escapeHtml(source.id)}">
    <td><span class="repo-name">${escapeHtml(titleCase(source.name))}</span><span class="repo-slug">${escapeHtml(orgRepoSlug(source.repository))}</span></td>
    <td>${alerts ? openCount : '<span class="muted">Not scanned</span>'}</td>
    <td>${severity}</td>
    <td>${generatedAt}</td>
  </tr>`;
  const detailRow = `<tr class="repo-alert-detail-row" data-detail-for="${escapeHtml(source.id)}" hidden><td colspan="4"><div class="repo-alert-detail">${alertDetailTable(alerts)}</div></td></tr>`;
  return summaryRow + detailRow;
}

function alertDetailTable(alerts) {
  if (!alerts || !alerts.alerts?.length) return '<p class="no-alerts-note">No open alerts.</p>';
  return `<table class="data-table"><thead><tr><th>Severity</th><th>Package</th><th>Advisory</th><th>Patched version</th><th>Opened</th></tr></thead><tbody>${alerts.alerts.map((alert) => `<tr>
    <td><span class="severity-pill ${severityClass(alert.severity)}">${escapeHtml(alert.severity || 'unknown')}</span></td>
    <td><code>${escapeHtml(alert.packageName)}</code></td>
    <td><a href="${escapeHtml(alert.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(alert.summary || alert.ghsaId || alert.cveId || `#${alert.number}`)}</a></td>
    <td>${escapeHtml(alert.firstPatchedVersion || 'None available')}</td>
    <td>${alert.createdAt ? new Date(alert.createdAt).toLocaleDateString() : '—'}</td>
  </tr>`).join('')}</tbody></table>`;
}

async function loadLandscape() {
  destroyCy();
  toolbar.innerHTML = '';
  content.innerHTML = '<div class="loading">Reading catalogue data…</div>';
  state.selected = null;
  state.landscapePositions = null;
  state.landscapeChecked = null;
  try {
    const results = await Promise.all(state.catalog.map((source) => loadDependenciesFor(source)
      .then((data) => (data.dependencies?.length ? { source, dependencies: data.dependencies } : null))
      .catch(() => null)));
    state.landscape = buildLandscape(state.catalog, results.filter(Boolean));
    renderLandscape();
  } catch (error) {
    content.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

function landscapeChecklistGroup(title, nodes, formatLabel) {
  const checkedCount = nodes.filter((node) => state.landscapeChecked.has(node.id)).length;
  return `<div class="checklist-group">
    <h4>${escapeHtml(title)} <span class="count">${checkedCount}/${nodes.length}</span></h4>
    <ul class="checklist">${nodes.map((node) => `
      <li><label><input type="checkbox" data-landscape-toggle="${escapeHtml(node.id)}" ${state.landscapeChecked.has(node.id) ? 'checked' : ''}><span>${escapeHtml(formatLabel(node.name))}</span></label></li>`).join('') || '<li class="muted">None recorded.</li>'}</ul>
  </div>`;
}

function renderLandscape() {
  const graph = state.landscape;
  const allNodes = [...graph.systems, ...graph.externals];
  const redisExternalCount = graph.externals.filter((node) => node.isRedis).length;
  $('#source-stats').innerHTML = `
    <div class="stat"><dt>Systems</dt><dd>${graph.systems.length}</dd></div>
    <div class="stat"><dt>External</dt><dd>${graph.externals.length}</dd></div>
    <div class="stat"><dt>Relationships</dt><dd>${graph.edges.length}</dd></div>`;
  toolbar.innerHTML = `${diagramControlsHtml()}<span class="spacer"></span><span class="toolbar-meta">Inferred by matching each repository's outbound service dependencies and handled events/commands against the catalogue, clustering the rest as external systems${redisExternalCount ? ` · ${redisExternalCount} using Redis` : ''}</span>`;
  if (!allNodes.length) {
    destroyCy();
    content.innerHTML = '<div class="empty-state"><span class="empty-icon" aria-hidden="true">◇</span><h2>No dependency data available</h2><p>None of the cataloged repositories publish service-dependencies data.</p></div>';
    return;
  }
  if (!state.landscapeChecked) state.landscapeChecked = new Set(allNodes.map((node) => node.id));
  const visibleNodes = allNodes.filter((node) => state.landscapeChecked.has(node.id));
  if (!state.selected || !visibleNodes.some((node) => node.id === state.selected)) state.selected = visibleNodes[0]?.id || null;

  const checklistHtml = `<aside class="landscape-checklist" aria-label="Services to show">
    <div class="checklist-controls">
      <button id="landscape-select-all" type="button" class="plain-button">Select all</button>
      <button id="landscape-deselect-all" type="button" class="plain-button">Deselect all</button>
    </div>
    ${landscapeChecklistGroup('Systems', graph.systems, titleCase)}
    ${landscapeChecklistGroup('External systems', graph.externals, splitPascalCase)}
  </aside>`;

  if (!visibleNodes.length) {
    destroyCy();
    content.innerHTML = `<div class="landscape-layout">${checklistHtml}<div class="empty-state"><h2>Nothing selected</h2><p>Check at least one service on the left to see it on the diagram.</p></div></div>`;
    wireLandscapeChecklist(allNodes);
    return;
  }

  const VIEW_W = 1440, VIEW_H = 880;
  const center = { x: VIEW_W / 2, y: VIEW_H / 2 };
  const nodeHalfW = 98, nodeHalfH = 48, pad = 26;
  const systemsRx = 300, systemsRy = 190;
  const boundaryRx = systemsRx + nodeHalfW + pad;
  const boundaryRy = systemsRy + nodeHalfH + pad;
  const externalScale = 1.4;
  const systemNodes = ringLayout(graph.systems, center, systemsRx, systemsRy, 0)
    .filter((node) => state.landscapeChecked.has(node.id));
  const externalNodes = ringLayout(graph.externals, center, boundaryRx * externalScale, boundaryRy * externalScale, graph.externals.length ? Math.PI / graph.externals.length : 0)
    .filter((node) => state.landscapeChecked.has(node.id));
  const visibleEdges = graph.edges.filter((edge) => state.landscapeChecked.has(edge.from) && state.landscapeChecked.has(edge.to));
  if (!state.landscapePositions) state.landscapePositions = new Map();
  const positions = state.landscapePositions;
  [...systemNodes, ...externalNodes].forEach((node) => positionFor(positions, node.id, node));
  const orgLabel = orgFromRepoUrl(graph.systems[0]?.repository);

  const elements = [
    { data: { id: 'boundary', label: orgLabel.toUpperCase() } },
    ...systemNodes.map((node) => ({
      data: { id: node.id, parent: 'boundary', isLeaf: true, width: 210, height: 98, name: node.name, relCount: visibleEdges.filter((edge) => edge.from === node.id || edge.to === node.id).length },
      position: positions.get(node.id)
    })),
    ...externalNodes.map((node) => ({
      data: { id: node.id, isLeaf: true, width: 196, height: 96, name: node.name, memberCount: node.members.length, isRedis: node.isRedis },
      position: positions.get(node.id)
    })),
    ...visibleEdges.map((edge, index) => {
      const reference = edge.references[0];
      return { data: { id: `land-edge-${index}`, source: edge.from, target: edge.to, label: edgeLabel(edge), jumpSourceId: reference?.sourceId || '', jumpIndex: reference?.dependencyIndex ?? '' }, classes: [reference ? 'jumpable' : '', edge.isRedis ? 'redis' : ''].filter(Boolean).join(' ') };
    })
  ];

  content.innerHTML = `<div class="landscape-layout">
    ${checklistHtml}
    <div class="dependency-view">
      <div class="c4-legend">
        <span class="c4-legend-item"><span class="c4-swatch internal"></span>Software system (cataloged)</span>
        <span class="c4-legend-item"><span class="c4-swatch external"></span>External system</span>
        <span class="c4-legend-item"><span class="c4-swatch cache"></span>Uses Redis</span>
        <span class="c4-legend-item"><span class="c4-boundary-swatch"></span>${escapeHtml(orgLabel)} system boundary</span>
        <span class="c4-legend-item">Click a relationship line to open its dependency</span>
      </div>
      <div id="land-cy" class="cy-container" role="group" aria-label="C4 system landscape diagram"></div>
      <div id="land-detail">${landscapeDetail(allNodes.find((node) => node.id === state.selected), graph)}</div>
    </div>
  </div>`;

  mountCy({
    container: $('#land-cy'),
    elements,
    layout: { name: 'preset' },
    htmlLabels: [{
      query: 'node[?isLeaf]',
      halign: 'center', valign: 'center', halignBox: 'center', valignBox: 'center',
      tpl: (data) => {
        if (data.parent === 'boundary') return `<div class="cy-node internal" data-node-id="${escapeHtml(data.id)}"><span class="c4-type">Software System</span><strong>${escapeHtml(titleCase(data.name))}</strong><span class="c4-meta">${data.relCount} relationship(s)</span></div>`;
        const nodeClass = data.isRedis ? 'cache' : 'external';
        return `<div class="cy-node ${nodeClass}" data-node-id="${escapeHtml(data.id)}"><span class="c4-type">${data.isRedis ? 'Redis' : 'External System'}</span><strong>${escapeHtml(splitPascalCase(data.name))}</strong><span class="c4-meta">${data.memberCount} reference(s)</span></div>`;
      }
    }],
    onTapNode: (node) => {
      state.selected = node.id();
      markCySelection($('#land-cy'), state.selected);
      $('#land-detail').innerHTML = landscapeDetail(allNodes.find((item) => item.id === state.selected), graph);
    },
    onTapEdge: (edge) => {
      const sourceId = edge.data('jumpSourceId');
      if (sourceId) jumpToSource(sourceId, edge.data('jumpIndex'));
    },
    onDragFree: (node) => { positions.set(node.id(), node.position()); }
  });
  markCySelection($('#land-cy'), state.selected);
  document.querySelectorAll('[data-jump]').forEach((button) => { button.onclick = () => jumpToSource(button.dataset.jump); });
  wireDiagramControls(() => { positions.clear(); renderLandscape(); });
  wireLandscapeChecklist(allNodes);
}

function wireLandscapeChecklist(allNodes) {
  document.querySelectorAll('[data-landscape-toggle]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const id = checkbox.dataset.landscapeToggle;
      if (checkbox.checked) state.landscapeChecked.add(id); else state.landscapeChecked.delete(id);
      renderLandscape();
    });
  });
  const selectAll = $('#landscape-select-all');
  if (selectAll) selectAll.onclick = () => { state.landscapeChecked = new Set(allNodes.map((node) => node.id)); renderLandscape(); };
  const deselectAll = $('#landscape-deselect-all');
  if (deselectAll) deselectAll.onclick = () => { state.landscapeChecked = new Set(); renderLandscape(); };
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

async function jumpToSource(sourceId, dependencyIndex = null) {
  const target = state.catalog.find((source) => source.id === sourceId);
  state.mode = 'source';
  history.pushState({}, '', `/service/${encodeURIComponent(sourceId)}`);
  applyMode();
  sourceSelect.value = sourceId;
  if (target && (target.capabilities.dependencies || target.capabilities.messages)) state.view = 'dependencies';
  await selectSource(sourceId);
  if (state.view === 'dependencies' && dependencyIndex !== null) {
    state.selected = String(dependencyIndex);
    renderDependencies(false);
  }
}

function githubFileUrl(path, scanKind = 'eventcatalog') {
  if (!path) return null;
  const revision = state.data?.ref || state.source.scans[scanKind]?.['last-commit-hash-scanned'] || 'HEAD';
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `${state.source.repository.replace(/\/$/, '')}/blob/${encodeURIComponent(revision)}/${encodedPath}`;
}

function sourceLink(path, scanKind = 'eventcatalog') {
  const url = githubFileUrl(path, scanKind);
  if (!url) return '<span class="muted">Not recorded</span>';
  return `<a class="source-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer"><code>${escapeHtml(path)}</code><span aria-hidden="true"> ↗</span><span class="sr-only"> (opens on GitHub)</span></a>`;
}

function dependencyTooltipContent(dependency) {
  const ops = dependency.operations || [];
  const title = `<div class="node-tooltip-title">${escapeHtml(splitPascalCase(dependency.name))}${usesRedis(dependency) ? ' <span class="badge danger">Redis</span>' : ''}</div>`;
  const subtitle = dependency.description ? `<p class="node-tooltip-subtitle">${escapeHtml(dependency.description)}</p>` : '';
  if (!ops.length) return `${title}${subtitle}<p class="node-tooltip-empty">No operations recorded — click the box for full details.</p>`;
  const scanKind = dependency.kind === 'message' ? 'eventcatalog' : 'service-dependencies';
  const shown = ops.slice(0, 8);
  return `${title}${subtitle}<ul class="node-tooltip-list">${shown.map((operation) => {
    const url = githubFileUrl(operation.sourceFile, scanKind);
    const label = operation.path && operation.path !== 'Not resolved' ? operation.path : (operation.methodName || operation.method || 'operation');
    return `<li><span class="method ${escapeHtml((operation.method || '').toLowerCase())}">${escapeHtml(operation.methodName || operation.method || '—')}</span>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>` : `<span class="muted">${escapeHtml(label)}</span>`}</li>`;
  }).join('')}</ul>${ops.length > shown.length ? `<p class="node-tooltip-more">+${ops.length - shown.length} more — click the box for full details</p>` : ''}`;
}

function operations(spec) {
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
  return Object.entries(spec.paths || {}).flatMap(([path, value]) => methods.filter((method) => value[method]).map((method) => ({ path, method, ...value[method] })));
}

function apiInfo() {
  return state.data.info || {};
}

function apiInfoBanner() {
  const info = apiInfo();
  if (!info.title && !info.version && !info.description) return '';
  return `<div class="api-info">
    <h2>${escapeHtml(info.title || 'API')}</h2>
    ${info.version ? `<span class="badge blue">v${escapeHtml(info.version)}</span>` : ''}
    ${info.description ? `<p class="muted">${escapeHtml(info.description)}</p>` : ''}
  </div>`;
}

function resolveRef(ref) {
  if (!ref || !ref.startsWith('#/components/schemas/')) return null;
  const name = ref.replace('#/components/schemas/', '');
  const schema = state.data.components?.schemas?.[name];
  return schema ? { name, schema } : null;
}

function schemaTypeLabel(schema = {}) {
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref);
    return resolved ? resolved.name : schema.$ref.split('/').pop();
  }
  if (schema.type === 'array') return `${schemaTypeLabel(schema.items || {})}[]`;
  if (schema.enum) return 'enum';
  return [schema.type, schema.format].filter(Boolean).join(' · ') || 'object';
}

function schemaRefPill(name) {
  return `<button class="model-pill" type="button" data-model="${escapeHtml(name)}">${escapeHtml(name)}</button>`;
}

function renderSchemaSummary(schema = {}) {
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref);
    return resolved ? schemaRefPill(resolved.name) : `<code>${escapeHtml(schema.$ref.split('/').pop())}</code>`;
  }
  if (schema.type === 'array') return `array&lt;${renderSchemaSummary(schema.items || {})}&gt;`;
  if (schema.enum) return schema.enum.map((value) => `<span class="badge">${escapeHtml(String(value))}</span>`).join(' ');
  return `<code>${escapeHtml([schema.type, schema.format].filter(Boolean).join(' · ') || 'object')}</code>`;
}

function renderSchemaTable(schema, seen = new Set()) {
  if (!schema) return '<p class="muted">No schema.</p>';
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref);
    if (!resolved) return `<p class="muted">Unresolved reference <code>${escapeHtml(schema.$ref)}</code></p>`;
    if (seen.has(resolved.name)) return `<p class="muted">${schemaRefPill(resolved.name)} — circular reference</p>`;
    return `${schemaRefPill(resolved.name)}${renderSchemaTable(resolved.schema, new Set([...seen, resolved.name]))}`;
  }
  if (schema.type === 'array') {
    return `<p class="schema-hint">Array of:</p>${renderSchemaTable(schema.items || {}, seen)}`;
  }
  if (schema.enum) {
    return `<div class="enum-values">${schema.enum.map((value) => `<span class="badge amber">${escapeHtml(String(value))}</span>`).join(' ')}</div>`;
  }
  const properties = Object.entries(schema.properties || {});
  if (!properties.length) {
    return `<p class="muted">${escapeHtml(schemaTypeLabel(schema))}${schema.description ? ` — ${escapeHtml(schema.description)}` : ''}${schema.additionalProperties ? ' · additional properties allowed' : ''}</p>`;
  }
  const required = new Set(schema.required || []);
  return `<div class="table-wrap"><table class="data-table schema-table"><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead><tbody>${properties.map(([key, value]) => {
    const nestedSchema = !value.$ref && value.type === 'object' && value.properties ? value : (!value.$ref && value.type === 'array' && value.items && !value.items.$ref && value.items.type === 'object' && value.items.properties ? value.items : null);
    return `<tr>
      <td><code>${escapeHtml(key)}</code>${required.has(key) ? ' <span class="required-mark" title="Required">*</span>' : ''}${value.nullable ? ' <span class="badge">nullable</span>' : ''}</td>
      <td>${renderSchemaSummary(value)}</td>
      <td class="muted">${escapeHtml(value.description || '—')}</td>
    </tr>${nestedSchema ? `<tr class="nested-row"><td></td><td colspan="2"><details><summary>Show fields</summary>${renderSchemaTable(nestedSchema, seen)}</details></td></tr>` : ''}`;
  }).join('')}</tbody></table></div>`;
}

function requestBody(body) {
  if (!body) return '';
  const media = body.content?.['application/json'] || Object.values(body.content || {})[0];
  return `<h3>Request body${body.required ? ' <span class="badge amber">required</span>' : ''}</h3>${media?.schema ? renderSchemaTable(media.schema) : '<p class="muted">No schema.</p>'}`;
}

function responseBlock(status, response) {
  const media = response.content?.['application/json'] || Object.values(response.content || {})[0];
  return `<div class="response-block">
    <div class="response-head"><span class="response-code">${escapeHtml(status)}</span><span>${escapeHtml(response.description || 'No description')}</span>${media?.schema ? `<span class="muted">${renderSchemaSummary(media.schema)}</span>` : ''}</div>
    ${media?.schema ? `<details class="response-schema"><summary>Schema</summary>${renderSchemaTable(media.schema)}</details>` : ''}
  </div>`;
}

function wireModelLinks() {
  document.querySelectorAll('[data-model]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      state.apiView = 'schemas';
      state.selectedModel = button.dataset.model;
      renderOpenApi(true);
    });
  });
}

function renderModels() {
  const schemas = state.data.components?.schemas || {};
  const names = Object.keys(schemas).sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    content.innerHTML = `<div class="openapi-view">${apiInfoBanner()}<div class="empty-state"><span class="empty-icon" aria-hidden="true">◇</span><h2>No component schemas</h2><p>This specification does not define any reusable models.</p></div></div>`;
    return;
  }
  if (!state.selectedModel || !names.includes(state.selectedModel)) state.selectedModel = names[0];
  content.innerHTML = `<div class="openapi-view">${apiInfoBanner()}<div class="split"><aside class="item-list">${names.map((name) => `<button class="list-button" type="button" data-model-select="${escapeHtml(name)}" aria-current="${state.selectedModel === name}"><span class="list-title">${escapeHtml(name)}</span><span class="list-meta">${schemaTypeLabel(schemas[name])} · ${Object.keys(schemas[name].properties || {}).length} fields</span></button>`).join('')}</aside><div class="detail">${modelDetail(state.selectedModel, schemas[state.selectedModel])}</div></div></div>`;
  document.querySelectorAll('[data-model-select]').forEach((button) => button.addEventListener('click', () => { state.selectedModel = button.dataset.modelSelect; renderOpenApi(true); }));
  wireModelLinks();
}

function modelDetail(name, schema) {
  return `<span class="badge blue">${escapeHtml(schemaTypeLabel(schema))}</span>
    <h2>${escapeHtml(name)}</h2>
    ${schema.description ? `<p class="detail-subtitle">${escapeHtml(schema.description)}</p>` : ''}
    ${renderSchemaTable(schema, new Set([name]))}
    <details><summary>Raw schema JSON</summary><pre>${escapeHtml(JSON.stringify(schema, null, 2))}</pre></details>`;
}

function renderOpenApi(resetToolbar = true) {
  if (!state.apiView) state.apiView = 'operations';
  const ops = operations(state.data);
  const schemaCount = Object.keys(state.data.components?.schemas || {}).length;
  if (resetToolbar) {
    toolbar.innerHTML = `<label class="source-picker" for="api-file"><span>Specification</span><select id="api-file">${state.source.apiFiles.map((file) => `<option value="${escapeHtml(file)}" ${file === state.apiFile ? 'selected' : ''}>${escapeHtml(file.replace('.openapi.json', ''))}</option>`).join('')}</select></label>${state.apiView === 'operations' ? searchControl('Filter paths or operations') : ''}${schemaCount ? `<div class="segmented" role="group" aria-label="OpenAPI view"><button data-api-view="operations" aria-pressed="${state.apiView === 'operations'}">Operations</button><button data-api-view="schemas" aria-pressed="${state.apiView === 'schemas'}">Schemas</button></div>` : ''}<span class="spacer"></span><span class="toolbar-meta">${ops.length} operations · ${schemaCount} models</span>`;
    const apiFile = $('#api-file');
    if (apiFile) apiFile.onchange = async (event) => { state.apiFile = event.target.value; state.selected = null; state.selectedModel = null; await loadView(); };
    document.querySelectorAll('[data-api-view]').forEach((button) => { button.onclick = () => { state.apiView = button.dataset.apiView; state.filter = ''; renderOpenApi(true); }; });
  }
  if (state.apiView === 'schemas') { renderModels(); return; }
  const filtered = ops.filter((op) => `${op.method} ${op.path} ${op.summary} ${(op.tags || []).join(' ')}`.toLowerCase().includes(state.filter));
  if (!state.selected || !filtered.some((op) => `${op.method}:${op.path}` === state.selected)) state.selected = filtered[0] ? `${filtered[0].method}:${filtered[0].path}` : null;
  const selected = ops.find((op) => `${op.method}:${op.path}` === state.selected);
  content.innerHTML = `<div class="openapi-view">${apiInfoBanner()}<div class="split"><aside class="item-list">${filtered.map((op) => `<button class="list-button" type="button" data-operation="${escapeHtml(`${op.method}:${op.path}`)}" aria-current="${state.selected === `${op.method}:${op.path}`}"><span class="list-title"><span class="method ${op.method}">${op.method}</span><span class="endpoint-path">${escapeHtml(op.path)}</span></span><span class="list-meta">${escapeHtml(op.summary || op.operationId || 'No summary')}</span></button>`).join('') || '<div class="detail muted">No matching operations.</div>'}</aside><div class="detail">${selected ? operationDetail(selected) : ''}</div></div></div>`;
  wireSearch();
  document.querySelectorAll('[data-operation]').forEach((button) => button.addEventListener('click', () => { state.selected = button.dataset.operation; renderOpenApi(false); }));
  wireModelLinks();
}

function operationDetail(op) {
  const parameters = op.parameters || [];
  const responses = Object.entries(op.responses || {});
  return `<span class="method ${op.method}">${op.method}</span><h2 class="endpoint-path">${escapeHtml(op.path)}</h2><p class="detail-subtitle">${escapeHtml(op.summary || op.operationId || 'No summary')}</p>
    ${op.description ? `<p>${escapeHtml(op.description)}</p>` : ''}<div class="badges">${(op.tags || []).map((tag) => `<span class="badge blue">${escapeHtml(tag)}</span>`).join('')}</div>
    <h3>Parameters</h3>${parameters.length ? `<table class="data-table"><thead><tr><th>Name</th><th>Location</th><th>Type</th><th>Required</th></tr></thead><tbody>${parameters.map((parameter) => `<tr><td><code>${escapeHtml(parameter.name)}</code></td><td>${escapeHtml(parameter.in)}</td><td>${renderSchemaSummary(parameter.schema || {})}</td><td>${parameter.required ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No parameters.</p>'}
    ${requestBody(op.requestBody)}
    <h3>Responses</h3>${responses.length ? responses.map(([status, response]) => responseBlock(status, response)).join('') : '<p class="muted">No responses documented.</p>'}
    <details><summary>Raw operation JSON</summary><pre>${escapeHtml(JSON.stringify(op, null, 2))}</pre></details>`;
}

function localServiceCard(service) {
  return `<article class="service-card">
    <div class="badges"><span class="badge blue">${escapeHtml(service.kind || 'service')}</span>${service.technology ? `<span class="badge">${escapeHtml(service.technology)}</span>` : ''}</div>
    <h3>${escapeHtml(service.name)}</h3>
    ${service.configurationKeys?.length ? `<ul class="code-list">${service.configurationKeys.map((key) => `<li><code>${escapeHtml(key)}</code></li>`).join('')}</ul>` : '<p class="muted">No configuration keys recorded.</p>'}
    ${service.evidence?.length ? `<details><summary>${service.evidence.length} evidence item${service.evidence.length === 1 ? '' : 's'}</summary>${dependencyEvidence(service.evidence, 'localdev')}</details>` : ''}
  </article>`;
}

function renderLocalDev(resetToolbar = true) {
  const services = state.data.localServices || [];
  const keys = state.data.configurationKeys || [];
  if (resetToolbar) toolbar.innerHTML = `${searchControl('Filter services or configuration keys')}<span class="spacer"></span><span class="toolbar-meta">${services.length} local service${services.length === 1 ? '' : 's'} · ${keys.length} configuration keys</span>`;
  const filteredServices = services.filter((service) => `${service.name} ${service.kind} ${service.technology}`.toLowerCase().includes(state.filter));
  const filteredKeys = keys.filter((entry) => `${entry.key} ${entry.sourceFile} ${entry.reason}`.toLowerCase().includes(state.filter));
  if (!services.length && !keys.length) {
    content.innerHTML = '<div class="empty-state"><span class="empty-icon" aria-hidden="true">◇</span><h2>No local dev configuration recorded</h2><p>The generated local-dev-config catalogue is empty.</p></div>';
    return;
  }
  content.innerHTML = `<div class="localdev-view">
    <section>
      <h2>Local services required</h2>
      ${filteredServices.length ? `<div class="service-cards">${filteredServices.map(localServiceCard).join('')}</div>` : '<p class="muted">No matching services.</p>'}
    </section>
    <section>
      <h2>Configuration keys</h2>
      ${filteredKeys.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Key</th><th>Source</th><th>Notes</th></tr></thead><tbody>${filteredKeys.map((entry) => `<tr><td><code>${escapeHtml(entry.key)}</code></td><td>${sourceLink(entry.sourceFile, 'localdev')}</td><td class="muted">${escapeHtml(entry.reason || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No matching configuration keys.</p>'}
    </section>
  </div>`;
  wireSearch();
}

function renderView(resetToolbar = true) {
  if (state.view === 'database') renderDatabase(resetToolbar);
  if (state.view === 'messages') renderMessages(resetToolbar);
  if (state.view === 'dependencies') renderDependencies();
  if (state.view === 'openapi') renderOpenApi(resetToolbar);
  if (state.view === 'localdev') renderLocalDev(resetToolbar);
}

tabs.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-view]');
  if (!button || button.disabled || button.dataset.view === state.view) return;
  state.view = button.dataset.view;
  state.selected = null;
  renderTabs();
  await loadView();
});

function modeFromPath(pathname) {
  if (pathname === '/landscape') return 'landscape';
  if (pathname === '/service' || pathname.startsWith('/service/')) return 'source';
  return 'home';
}

function sourceIdFromPath(pathname) {
  const match = pathname.match(/^\/service\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function resolveSourceId(requestedId) {
  if (state.catalog.some((source) => source.id === requestedId)) return requestedId;
  return sourceSelect.value || state.catalog[0].id;
}

sourceSelect.addEventListener('change', async () => {
  state.mode = 'source';
  history.pushState({}, '', `/service/${encodeURIComponent(sourceSelect.value)}`);
  applyMode();
  await selectSource(sourceSelect.value);
});

homeToggle.addEventListener('click', async (event) => {
  if (state.mode === 'home') return;
  event.preventDefault();
  state.mode = 'home';
  history.pushState({}, '', '/');
  applyMode();
  setHomeHero();
  await loadHomeDashboard();
});

landscapeToggle.addEventListener('click', async (event) => {
  if (state.mode === 'landscape') return;
  event.preventDefault();
  state.mode = 'landscape';
  history.pushState({}, '', '/landscape');
  applyMode();
  setLandscapeHero();
  await loadLandscape();
});

serviceToggle.addEventListener('click', async (event) => {
  if (state.mode === 'source') return;
  event.preventDefault();
  state.mode = 'source';
  const sourceId = resolveSourceId(sourceSelect.value);
  history.pushState({}, '', `/service/${encodeURIComponent(sourceId)}`);
  applyMode();
  sourceSelect.value = sourceId;
  await selectSource(sourceId);
});

window.addEventListener('popstate', async () => {
  const mode = modeFromPath(window.location.pathname);
  if (mode === state.mode) return;
  state.mode = mode;
  applyMode();
  if (mode === 'landscape') {
    setLandscapeHero();
    await loadLandscape();
  } else if (mode === 'source') {
    const sourceId = resolveSourceId(sourceIdFromPath(window.location.pathname));
    sourceSelect.value = sourceId;
    await selectSource(sourceId);
  } else {
    setHomeHero();
    await loadHomeDashboard();
  }
});

async function init() {
  try {
    const catalog = await getJson('/api/catalog');
    state.catalog = catalog.sources;
    if (!state.catalog.length) throw new Error('The manifest does not contain any sources.');
    sourceSelect.innerHTML = state.catalog.map((source) => `<option value="${source.id}">${escapeHtml(titleCase(source.name))}</option>`).join('');
    sourceSelect.value = state.catalog[0].id;
    state.mode = modeFromPath(window.location.pathname);
    applyMode();
    if (state.mode === 'landscape') {
      setLandscapeHero();
      await loadLandscape();
    } else if (state.mode === 'source') {
      const sourceId = resolveSourceId(sourceIdFromPath(window.location.pathname));
      sourceSelect.value = sourceId;
      await selectSource(sourceId);
    } else {
      setHomeHero();
      await loadHomeDashboard();
    }
  } catch (error) {
    content.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

init();
