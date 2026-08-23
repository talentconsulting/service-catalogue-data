const state = {
  catalog: [], source: null, view: 'database', data: null,
  filter: '', selected: null, messageType: 'all', apiFile: null,
  mode: 'source', landscape: null, apiView: 'operations', selectedModel: null, dbView: 'diagram', erdZoom: 1
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
    { id: 'dependencies', label: 'Dependencies', enabled: state.source.capabilities.dependencies || state.source.capabilities.messages },
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
  toolbar.innerHTML = '';
  content.innerHTML = '<div class="loading">Reading catalogue data…</div>';
  state.filter = '';
  state.selected = null;
  state.selectedModel = null;
  state.diagramPositions = null;
  state.schemaPositions = null;
  state.erdZoom = 1;
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
    toolbar.innerHTML = `${searchControl('Filter tables or columns')}<div class="segmented" role="group" aria-label="Schema view"><button data-db-view="diagram" aria-pressed="${state.dbView === 'diagram'}">Diagram</button><button data-db-view="grid" aria-pressed="${state.dbView === 'grid'}">Grid</button></div>${state.dbView === 'diagram' ? '<button id="auto-arrange" class="plain-button" type="button">Auto arrange</button><div class="diagram-zoom" role="group" aria-label="Diagram zoom"><button id="zoom-out" type="button" aria-label="Zoom out">−</button><button id="zoom-fit" type="button">Fit</button><button id="zoom-in" type="button" aria-label="Zoom in">+</button></div>' : ''}<span class="spacer"></span><span class="toolbar-meta">${tables.length} tables · ${columnCount} columns · ${relations} relationships</span>`;
    document.querySelectorAll('[data-db-view]').forEach((button) => { button.onclick = () => { state.dbView = button.dataset.dbView; state.filter = ''; state.selected = null; renderDatabase(true); }; });
    $('#auto-arrange')?.addEventListener('click', () => { state.schemaPositions = null; renderDatabase(false); });
    $('#zoom-out')?.addEventListener('click', () => { state.erdZoom = Math.max(0.5, state.erdZoom / 1.25); renderDatabase(false); });
    $('#zoom-in')?.addEventListener('click', () => { state.erdZoom = Math.min(2.5, state.erdZoom * 1.25); renderDatabase(false); });
    $('#zoom-fit')?.addEventListener('click', () => { state.erdZoom = 1; renderDatabase(false); });
  }
  const filtered = tables.filter((table) => `${table.schema} ${table.name} ${table.columns?.map((column) => column.name).join(' ')}`.toLowerCase().includes(state.filter));
  if (state.dbView === 'diagram') {
    const { edges, connectedTables, isolatedCount } = databaseGraph(tables);
    renderDatabaseDiagram(connectedTables.filter((table) => filtered.includes(table)), edges, isolatedCount);
  } else {
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

function orthogonalPath(points) {
  const middleY = (points.y1 + points.y2) / 2;
  return `M ${points.x1} ${points.y1} L ${points.x1} ${middleY} L ${points.x2} ${middleY} L ${points.x2} ${points.y2}`;
}

function zoomedDiagramPosition(position, viewWidth, viewHeight, zoom) {
  return {
    x: viewWidth / 2 + (position.x - viewWidth / 2) * zoom,
    y: viewHeight / 2 + (position.y - viewHeight / 2) * zoom
  };
}

function connectionPoints(from, to, fromWidth = 0, fromHeight = 0, toWidth = 0, toHeight = 0) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (!dx && !dy) return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  const pointAtEdge = (origin, horizontal, vertical, width, height) => {
    if (!width || !height) return { x: origin.x, y: origin.y };
    const scale = Math.min(width / 2 / Math.abs(horizontal || 1), height / 2 / Math.abs(vertical || 1));
    return { x: origin.x + horizontal * scale, y: origin.y + vertical * scale };
  };
  const start = pointAtEdge(from, dx, dy, fromWidth, fromHeight);
  const end = pointAtEdge(to, -dx, -dy, toWidth, toHeight);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

function renderDatabaseDiagram(filtered, allEdges, isolatedCount) {
  const edges = allEdges.filter((edge) => filtered.some((table) => table.name === edge.from) && filtered.some((table) => table.name === edge.to));
  if (!filtered.length) {
    content.innerHTML = '<div class="empty-state"><h2>No matching tables with relationships</h2><p>Try a different search term, or switch to Grid to see every table.</p></div>';
    return;
  }
  const ordered = orderTablesForLayout(filtered, edges);
  const nodes = ordered.map(erNode);
  const levelEstimate = Math.max(2, Math.ceil(Math.sqrt(nodes.length)));
  const VIEW_W = Math.max(1100, levelEstimate * 380);
  const positioned = layoutErNodes(nodes, edges, VIEW_W);
  const VIEW_H = Math.max(720, Math.ceil(Math.max(...positioned.map((node) => node.y + node.height / 2)) + 80));
  if (!state.schemaPositions) state.schemaPositions = new Map();
  const positions = state.schemaPositions;
  positioned.forEach((node) => resolvedPosition(positions, node));
  const posOf = (node) => positions.get(node.id) || node;
  const erdZoom = state.erdZoom || 1;
  const pct = (value, axis) => `${((value / (axis === 'x' ? VIEW_W : VIEW_H)) * 100).toFixed(2)}%`;
  if (!state.selected || !filtered.some((table) => table.name === state.selected)) state.selected = positioned[0]?.name || null;
  const selectedTable = filtered.find((table) => table.name === state.selected);

  content.innerHTML = `<div class="dependency-view">
    ${isolatedCount ? `<p class="toolbar-meta">${isolatedCount} table${isolatedCount === 1 ? '' : 's'} with no foreign keys — switch to Grid to browse them.</p>` : ''}
    <div class="dependency-graph er-diagram" role="group" aria-label="Database relationship diagram" style="min-height:${VIEW_H}px">
      <svg viewBox="${VIEW_W / 2 - VIEW_W / (2 * erdZoom)} ${VIEW_H / 2 - VIEW_H / (2 * erdZoom)} ${VIEW_W / erdZoom} ${VIEW_H / erdZoom}" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
        <defs><marker id="schema-arrow-outbound" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>
        ${edges.map((edge, index) => {
          const from = posOf({ id: edge.from });
          const to = posOf({ id: edge.to });
          const fromNode = positioned.find((node) => node.name === edge.from);
          const toNode = positioned.find((node) => node.name === edge.to);
          const points = connectionPoints(from, to, fromNode?.width, fromNode?.height, toNode?.width, toNode?.height);
          const edgeId = `schema-edge-${index}`;
          return `<path id="${edgeId}" class="outbound" data-edge-id="${edgeId}" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" data-from-width="${fromNode?.width || 0}" data-from-height="${fromNode?.height || 0}" data-to-width="${toNode?.width || 0}" data-to-height="${toNode?.height || 0}" d="${orthogonalPath(points)}" marker-end="url(#schema-arrow-outbound)"></path>
            `;
        }).join('')}
      </svg>
      ${positioned.map((node) => {
        const pos = zoomedDiagramPosition(posOf(node), VIEW_W, VIEW_H, erdZoom);
        const foreignKeys = new Set((node.relationships || []).flatMap((relationship) => relationship.fromColumns || []));
        return `<button class="er-node" type="button" data-node="${escapeHtml(node.name)}" aria-pressed="${node.name === state.selected}" style="--erd-zoom:${erdZoom};left:${pct(pos.x, 'x')};top:${pct(pos.y, 'y')};width:${node.width}px;height:${node.height}px"><span class="er-table"><span>${escapeHtml(node.schema)}</span>${escapeHtml(node.name)}</span><span class="er-columns">${(node.columns || []).map((column) => `<span class="er-column"><b>${column.primaryKey ? 'PK' : foreignKeys.has(column.name) ? 'FK' : ''}</b><code>${escapeHtml(column.name)}</code><em>${escapeHtml(column.type || '')}</em></span>`).join('') || '<span class="er-column muted">No columns recorded</span>'}</span></button>`;
      }).join('')}
    </div>
    ${selectedTable ? tableDetailInline(selectedTable) : ''}
  </div>`;
  makeDraggableGraph($('.dependency-graph'), positions, VIEW_W, VIEW_H, erdZoom);
  document.querySelectorAll('[data-node]').forEach((button) => button.addEventListener('click', () => { state.selected = button.dataset.node; renderDatabase(false); }));
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
  const verb = edge.kinds.includes('message') && !edge.kinds.includes('http-api') ? 'Publishes to' : 'Calls';
  return `${verb}${technology ? ` [${technology}]` : ''}${edge.count > 1 ? ` ×${edge.count}` : ''}`;
}

function buildLandscape(sources, dependencySets) {
  const systemTokenMap = new Map(sources.map((s) => [s.id, new Set(tokenize(s.name))]));
  const edgeMap = new Map();

  function addEdge(from, to, dependency, reference) {
    const key = `${from}|${to}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { from, to, count: 0, operations: 0, technologies: new Set(), names: new Set(), kinds: new Set(), references: [] });
    const edge = edgeMap.get(key);
    edge.count += 1;
    edge.operations += dependency.operations?.length || 0;
    const kindLabel = dependency.kind === 'http-api' ? 'HTTP' : dependency.kind;
    [kindLabel, dependency.technology].filter(Boolean).forEach((value) => edge.technologies.add(value));
    edge.names.add(dependency.name);
    if (dependency.kind) edge.kinds.add(dependency.kind);
    if (reference) edge.references.push(reference);
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
    members.forEach((member) => {
      const [from, to] = member.dependency.direction === 'inbound' ? [id, `sys:${member.source.id}`] : [`sys:${member.source.id}`, id];
      addEdge(from, to, member.dependency, { sourceId: member.source.id, dependencyIndex: member.dependencyIndex });
    });
    externals.push({ id, name, members });
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

function resolvedPosition(positions, node) {
  if (!positions.has(node.id)) positions.set(node.id, { x: node.x, y: node.y });
  return positions.get(node.id);
}

function redrawEdgeLine(graphEl, line, positions) {
  const from = positions.get(line.dataset.from);
  const to = positions.get(line.dataset.to);
  if (!from || !to) return;
  const points = connectionPoints(from, to, Number(line.dataset.fromWidth || 0), Number(line.dataset.fromHeight || 0), Number(line.dataset.toWidth || 0), Number(line.dataset.toHeight || 0));
  if (line.tagName.toLowerCase() === 'path') line.setAttribute('d', orthogonalPath(points));
  else {
    line.setAttribute('x1', points.x1);
    line.setAttribute('y1', points.y1);
    line.setAttribute('x2', points.x2);
    line.setAttribute('y2', points.y2);
  }
  const midX = (points.x1 + points.x2) / 2;
  const midY = (points.y1 + points.y2) / 2;
  const bg = graphEl.querySelector(`#${line.dataset.edgeId}-bg`);
  const text = graphEl.querySelector(`#${line.dataset.edgeId}-text`);
  if (bg) {
    const halfWidth = Number(bg.dataset.halfWidth || 0);
    bg.setAttribute('x', midX - halfWidth);
    bg.setAttribute('y', midY - 9);
  }
  if (text) {
    text.setAttribute('x', midX);
    text.setAttribute('y', midY + 2);
  }
}

function makeDraggableGraph(graphEl, positions, viewW, viewH, zoom = 1) {
  if (!graphEl || window.matchMedia('(max-width: 760px)').matches) return;
  let drag = null;
  graphEl.querySelectorAll('[data-node]').forEach((el) => {
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const pos = positions.get(el.dataset.node);
      if (!pos) return;
      const rect = graphEl.getBoundingClientRect();
      const scale = (Math.min(rect.width / viewW, rect.height / viewH) || 1) * zoom;
      drag = { id: el.dataset.node, el, startX: event.clientX, startY: event.clientY, originX: pos.x, originY: pos.y, scale, moved: false };
      el.setPointerCapture(event.pointerId);
    });
    el.addEventListener('pointermove', (event) => {
      if (!drag || drag.el !== el) return;
      const dx = (event.clientX - drag.startX) / drag.scale;
      const dy = (event.clientY - drag.startY) / drag.scale;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
      const next = { x: drag.originX + dx, y: drag.originY + dy };
      positions.set(drag.id, next);
      const displayPosition = zoomedDiagramPosition(next, viewW, viewH, zoom);
      el.style.left = `${(displayPosition.x / viewW * 100).toFixed(2)}%`;
      el.style.top = `${(displayPosition.y / viewH * 100).toFixed(2)}%`;
      graphEl.querySelectorAll(`[data-edge-id][data-from="${drag.id}"], [data-edge-id][data-to="${drag.id}"]`).forEach((line) => redrawEdgeLine(graphEl, line, positions));
    });
    el.addEventListener('pointerup', (event) => {
      if (!drag || drag.el !== el) return;
      el.releasePointerCapture(event.pointerId);
      if (drag.moved) el.dataset.justDragged = 'true';
      drag = null;
    });
    el.addEventListener('click', (event) => {
      if (el.dataset.justDragged === 'true') {
        delete el.dataset.justDragged;
        event.stopPropagation();
        event.preventDefault();
      }
    }, true);
  });
}

function renderDependencies(resetToolbar = true) {
  const dependencies = (state.data.dependencies || []).map((dependency, index) => ({ ...dependency, id: String(index) }));
  const operations = dependencies.reduce((sum, dependency) => sum + (dependency.operations?.length || 0), 0);
  const internalCount = dependencies.filter((dependency) => dependency.classification === 'internal').length;
  const messageCount = dependencies.filter((dependency) => dependency.kind === 'message').length;
  if (resetToolbar) toolbar.innerHTML = `${searchControl('Filter dependencies')}<span class="spacer"></span><span class="toolbar-meta">${dependencies.length} dependencies · ${internalCount} internal · ${dependencies.length - internalCount} external · ${messageCount} message-based · ${operations} operations</span>`;
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
  if (!state.diagramPositions) state.diagramPositions = new Map();
  const positions = state.diagramPositions;
  positions.set('center', positions.get('center') || { x: center.x, y: center.y });
  nodes.forEach((node) => resolvedPosition(positions, node));
  const pct = (value, axis) => `${((value / (axis === 'x' ? VIEW_W : VIEW_H)) * 100).toFixed(2)}%`;
  const posOf = (node) => positions.get(node.id) || node;
  const centerPos = positions.get('center');
  content.innerHTML = `<div class="dependency-view">
    <div class="c4-legend">
      <span class="c4-legend-item"><span class="c4-swatch focus"></span>Software system (this service)</span>
      <span class="c4-legend-item"><span class="c4-swatch internal"></span>Container — internal</span>
      <span class="c4-legend-item"><span class="c4-swatch external"></span>External system</span>
      <span class="c4-legend-item"><span class="c4-boundary-swatch"></span>${escapeHtml(orgName(state.data.repository))} system boundary</span>
      <span class="c4-legend-item">Drag any box to rearrange</span>
    </div>
    <div class="dependency-graph" role="group" aria-label="C4 container diagram for ${escapeHtml(titleCase(state.source.name))}">
      <svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="arrow-outbound" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>
          <marker id="arrow-inbound" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>
        </defs>
        <ellipse class="c4-boundary" cx="${center.x}" cy="${center.y}" rx="${boundaryRx}" ry="${boundaryRy}"></ellipse>
        <text class="c4-boundary-label" x="${center.x - boundaryRx + 18}" y="${center.y - boundaryRy + 26}">${escapeHtml(orgName(state.data.repository))}</text>
        ${nodes.map((node, index) => {
          const pos = posOf(node);
          const inbound = node.direction === 'inbound';
          const [fromId, toId] = inbound ? [node.id, 'center'] : ['center', node.id];
          const [x1, y1, x2, y2] = inbound ? [pos.x, pos.y, centerPos.x, centerPos.y] : [centerPos.x, centerPos.y, pos.x, pos.y];
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;
          const label = relationshipLabel(node);
          const halfWidth = label.length * 3.3;
          const edgeId = `dep-edge-${index}`;
          return `<line id="${edgeId}" class="${inbound ? 'inbound' : 'outbound'}" data-edge-id="${edgeId}" data-from="${escapeHtml(fromId)}" data-to="${escapeHtml(toId)}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#arrow-${inbound ? 'inbound' : 'outbound'})"></line>
            <rect id="${edgeId}-bg" class="rel-label-bg" data-half-width="${halfWidth}" x="${midX - halfWidth}" y="${midY - 9}" width="${halfWidth * 2}" height="15" rx="4"></rect>
            <text id="${edgeId}-text" class="rel-label" x="${midX}" y="${midY + 2}" text-anchor="middle">${escapeHtml(label)}</text>`;
        }).join('')}
      </svg>
      <div class="dependency-node service-node" data-node="center" style="left:${pct(centerPos.x, 'x')};top:${pct(centerPos.y, 'y')}"><span class="c4-type">Software System</span><strong>${escapeHtml(titleCase(state.source.name))}</strong></div>
      ${nodes.map((node) => {
        const pos = posOf(node);
        const nodeClass = node.kind === 'message' ? 'message' : (node.classification === 'internal' ? 'internal' : 'external');
        return `<button class="dependency-node ${nodeClass}" type="button" data-node="${escapeHtml(node.id)}" data-dependency="${escapeHtml(node.id)}" aria-pressed="${node.id === state.selected}" style="left:${pct(pos.x, 'x')};top:${pct(pos.y, 'y')}"><span class="c4-type">${escapeHtml(c4Type(node))}</span><strong>${escapeHtml(splitPascalCase(node.name))}</strong><span class="c4-meta">${escapeHtml(node.technology || node.kind || 'service')} · ${node.operations?.length || 0} op${node.operations?.length === 1 ? '' : 's'}</span></button>`;
      }).join('')}
    </div>
    ${dependencyDetail(selected)}
  </div>`;
  wireSearch();
  makeDraggableGraph($('.dependency-graph'), positions, VIEW_W, VIEW_H);
  document.querySelectorAll('[data-dependency]').forEach((button) => { button.addEventListener('click', () => { state.selected = button.dataset.dependency; renderDependencies(false); }); });
}

function dependencyDetail(dependency) {
  const authentication = dependency.authentication || {};
  const scanKind = dependency.kind === 'message' ? 'eventcatalog' : 'service-dependencies';
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
    <h3>Operations</h3>${dependencyOperations(dependency.operations || [], scanKind)}
    <h3>Configuration</h3>${dependencyKeys([...(dependency.configurationKeys || []), ...(authentication.configurationKeys || [])])}
    ${(dependency.resources || []).length ? `<h3>Resources</h3>${dependencyResources(dependency.resources)}` : ''}
    <h3>Evidence</h3>${dependencyEvidence(dependency.evidence || [], scanKind)}
  </article>`;
}

function dependencyOperations(operations, scanKind = 'service-dependencies') {
  if (!operations.length) return '<p class="muted">No operations recorded.</p>';
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Method</th><th>Path</th><th>Source</th></tr></thead><tbody>${operations.map((operation) => `<tr><td><span class="method ${escapeHtml((operation.method || '').toLowerCase())}">${escapeHtml(operation.method || '—')}</span></td><td><code>${escapeHtml(operation.path || 'Not resolved')}</code></td><td>${sourceLink(operation.sourceFile, scanKind)}</td></tr>`).join('')}</tbody></table></div>`;
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
  $('#source-title').textContent = 'System landscape';
  $('#source-stats').innerHTML = '';
}

async function loadLandscape() {
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
  $('#source-stats').innerHTML = `
    <div class="stat"><dt>Systems</dt><dd>${graph.systems.length}</dd></div>
    <div class="stat"><dt>External</dt><dd>${graph.externals.length}</dd></div>
    <div class="stat"><dt>Relationships</dt><dd>${graph.edges.length}</dd></div>`;
  toolbar.innerHTML = `<span class="toolbar-meta">Inferred by matching each repository's outbound service dependencies and handled events/commands against the catalogue, clustering the rest as external systems</span>`;
  if (!allNodes.length) {
    content.innerHTML = '<div class="empty-state"><span class="empty-icon" aria-hidden="true">◇</span><h2>No dependency data available</h2><p>None of the cataloged repositories publish service-dependencies data.</p></div>';
    return;
  }
  if (!state.landscapeChecked) state.landscapeChecked = new Set(allNodes.map((node) => node.id));
  const visibleNodes = allNodes.filter((node) => state.landscapeChecked.has(node.id));
  if (!state.selected || !visibleNodes.some((node) => node.id === state.selected)) state.selected = visibleNodes[0]?.id || null;
  const selected = allNodes.find((node) => node.id === state.selected);

  const checklistHtml = `<aside class="landscape-checklist" aria-label="Services to show">
    <div class="checklist-controls">
      <button id="landscape-select-all" type="button" class="plain-button">Select all</button>
      <button id="landscape-deselect-all" type="button" class="plain-button">Deselect all</button>
    </div>
    ${landscapeChecklistGroup('Systems', graph.systems, titleCase)}
    ${landscapeChecklistGroup('External systems', graph.externals, splitPascalCase)}
  </aside>`;

  if (!visibleNodes.length) {
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
  [...systemNodes, ...externalNodes].forEach((node) => resolvedPosition(positions, node));
  const posOf = (node) => positions.get(node.id) || node;
  const pct = (value, axis) => `${((value / (axis === 'x' ? VIEW_W : VIEW_H)) * 100).toFixed(2)}%`;
  const orgLabel = orgFromRepoUrl(graph.systems[0]?.repository);

  content.innerHTML = `<div class="landscape-layout">
    ${checklistHtml}
    <div class="dependency-view">
    <div class="c4-legend">
      <span class="c4-legend-item"><span class="c4-swatch internal"></span>Software system (cataloged)</span>
      <span class="c4-legend-item"><span class="c4-swatch external"></span>External system</span>
      <span class="c4-legend-item"><span class="c4-boundary-swatch"></span>${escapeHtml(orgLabel)} system boundary</span>
      <span class="c4-legend-item">Drag any box to rearrange</span>
    </div>
    <div class="dependency-graph" role="group" aria-label="C4 system landscape diagram">
      <svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="arrow-outbound" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>
        </defs>
        <ellipse class="c4-boundary" cx="${center.x}" cy="${center.y}" rx="${boundaryRx}" ry="${boundaryRy}"></ellipse>
        <text class="c4-boundary-label" x="${center.x - boundaryRx + 18}" y="${center.y - boundaryRy + 26}">${escapeHtml(orgLabel)}</text>
        ${visibleEdges.map((edge, index) => {
          if (!positions.has(edge.from) || !positions.has(edge.to)) return '';
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          const midX = (from.x + to.x) / 2;
          const midY = (from.y + to.y) / 2;
          const label = edgeLabel(edge);
          const halfWidth = label.length * 3.3;
          const edgeId = `land-edge-${index}`;
          const reference = edge.references[0];
          return `<line id="${edgeId}" class="outbound landscape-edge-link" data-edge-id="${edgeId}" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" data-dependency-jump="${escapeHtml(reference?.sourceId || '')}" data-dependency-index="${reference?.dependencyIndex ?? ''}" role="link" tabindex="0" aria-label="Open ${escapeHtml(label)} dependency details" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" marker-end="url(#arrow-outbound)"></line>
            <rect id="${edgeId}-bg" class="rel-label-bg" data-half-width="${halfWidth}" x="${midX - halfWidth}" y="${midY - 9}" width="${halfWidth * 2}" height="15" rx="4"></rect>
            <text id="${edgeId}-text" class="rel-label" x="${midX}" y="${midY + 2}" text-anchor="middle">${escapeHtml(label)}</text>`;
        }).join('')}
      </svg>
      ${systemNodes.map((node) => { const pos = posOf(node); return `<button class="dependency-node internal" type="button" data-node="${escapeHtml(node.id)}" aria-pressed="${node.id === state.selected}" style="left:${pct(pos.x, 'x')};top:${pct(pos.y, 'y')}"><span class="c4-type">Software System</span><strong>${escapeHtml(titleCase(node.name))}</strong><span class="c4-meta">${visibleEdges.filter((edge) => edge.from === node.id || edge.to === node.id).length} relationship(s)</span></button>`; }).join('')}
      ${externalNodes.map((node) => { const pos = posOf(node); return `<button class="dependency-node external" type="button" data-node="${escapeHtml(node.id)}" aria-pressed="${node.id === state.selected}" style="left:${pct(pos.x, 'x')};top:${pct(pos.y, 'y')}"><span class="c4-type">External System</span><strong>${escapeHtml(splitPascalCase(node.name))}</strong><span class="c4-meta">${node.members.length} reference(s)</span></button>`; }).join('')}
    </div>
    ${landscapeDetail(selected, graph)}
  </div>
  </div>`;
  makeDraggableGraph($('.dependency-graph'), positions, VIEW_W, VIEW_H);
  document.querySelectorAll('[data-node]').forEach((button) => { button.addEventListener('click', () => { state.selected = button.dataset.node; renderLandscape(); }); });
  document.querySelectorAll('[data-jump]').forEach((button) => { button.onclick = () => jumpToSource(button.dataset.jump); });
  document.querySelectorAll('.landscape-edge-link').forEach((edge) => {
    const openDependency = () => jumpToSource(edge.dataset.dependencyJump, Number(edge.dataset.dependencyIndex));
    edge.addEventListener('click', openDependency);
    edge.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDependency(); }
    });
  });
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
  applyMode();
  sourceSelect.value = sourceId;
  if (target && (target.capabilities.dependencies || target.capabilities.messages)) state.view = 'dependencies';
  await selectSource(sourceId);
  if (state.view === 'dependencies' && dependencyIndex !== null) {
    state.selected = String(dependencyIndex);
    renderDependencies(false);
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
