'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let collections = [];
let historyList = [];
let currentItem = null;   // { colId, itemId }
let respBodyRaw = '';
let respPretty = true;
let _pendingFolderColId = null;
let _syncingUrl = false;

let req = {
  method: 'GET',
  url: '',
  params: [kv()],
  headers: [kv()],
  body: { mode: 'none', raw: '', rawType: 'json', formData: [kv()], urlencoded: [kv()] },
  auth: { type: 'none', bearer: '', username: '', password: '' },
};

function kv() { return { id: uid(), key: '', value: '', enabled: true }; }
function uid() { return Math.random().toString(36).slice(2, 10); }
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── KV Editor ──────────────────────────────────────────────────────────────
function renderKV(containerId, items, onChange) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = '';
  items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'kv-row';
    row.innerHTML = `
      <input type="checkbox" class="kv-check" ${item.enabled ? 'checked' : ''}>
      <input type="text" class="kv-key" placeholder="Key" value="${esc(item.key)}">
      <input type="text" class="kv-val" placeholder="Value" value="${esc(item.value)}">
      <button class="kv-del" title="Delete">×</button>`;
    row.querySelector('.kv-check').onchange = e => { items[i].enabled = e.target.checked; onChange && onChange(items); };
    row.querySelector('.kv-key').oninput = e => { items[i].key = e.target.value; onChange && onChange(items); };
    row.querySelector('.kv-val').oninput = e => { items[i].value = e.target.value; onChange && onChange(items); };
    row.querySelector('.kv-del').onclick = () => {
      items.splice(i, 1);
      if (!items.length) items.push(kv());
      renderKV(containerId, items, onChange);
      onChange && onChange(items);
    };
    el.appendChild(row);
  });
  const btn = document.createElement('button');
  btn.className = 'btn-add-row';
  btn.textContent = '+ Add Row';
  btn.onclick = () => { items.push(kv()); renderKV(containerId, items, onChange); };
  el.appendChild(btn);
}

// ── URL ↔ Params sync ─────────────────────────────────────────────────────
function onUrlInput() {
  if (_syncingUrl) return;
  _syncingUrl = true;
  req.url = $('url').value;
  try {
    const q = req.url.indexOf('?');
    if (q >= 0) {
      const p = new URLSearchParams(req.url.slice(q + 1));
      req.params = [];
      p.forEach((v, k) => req.params.push({ id: uid(), key: k, value: v, enabled: true }));
      if (!req.params.length) req.params.push(kv());
      renderKV('params-editor', req.params, onParamsChange);
    }
  } catch(e) {}
  _syncingUrl = false;
}

function onParamsChange() {
  if (_syncingUrl) return;
  _syncingUrl = true;
  const base = req.url.split('?')[0];
  const active = req.params.filter(p => p.enabled && p.key);
  req.url = active.length
    ? base + '?' + active.map(p => encodeURIComponent(p.key) + '=' + encodeURIComponent(p.value)).join('&')
    : base;
  $('url').value = req.url;
  _syncingUrl = false;
}

// ── Body editor ───────────────────────────────────────────────────────────
function renderBody() {
  const mode = req.body.mode;
  const c = $('body-content');
  c.innerHTML = '';
  if (mode === 'none') {
    c.innerHTML = '<div class="empty-hint">该请求无 Body</div>';
  } else if (mode === 'raw') {
    c.innerHTML = `<div class="raw-toolbar">
      <select id="raw-type">
        <option value="json" ${req.body.rawType==='json'?'selected':''}>JSON</option>
        <option value="text" ${req.body.rawType==='text'?'selected':''}>Text</option>
        <option value="html" ${req.body.rawType==='html'?'selected':''}>HTML</option>
        <option value="xml"  ${req.body.rawType==='xml' ?'selected':''}>XML</option>
      </select>
    </div>
    <textarea id="body-raw" class="code-editor" placeholder="请求体...">${esc(req.body.raw)}</textarea>`;
    $('raw-type').onchange = e => { req.body.rawType = e.target.value; };
    $('body-raw').oninput = e => { req.body.raw = e.target.value; };
  } else if (mode === 'form-data') {
    c.innerHTML = '<div id="body-form-editor" class="kv-editor"></div>';
    renderKV('body-form-editor', req.body.formData, () => {});
  } else if (mode === 'urlencoded') {
    c.innerHTML = '<div id="body-urlencoded-editor" class="kv-editor"></div>';
    renderKV('body-urlencoded-editor', req.body.urlencoded, () => {});
  }
}

// ── Auth editor ───────────────────────────────────────────────────────────
function renderAuth() {
  const type = req.auth.type;
  const f = $('auth-fields');
  if (type === 'bearer') {
    f.innerHTML = `<div class="form-row"><label>Token</label>
      <input type="text" id="auth-bearer" class="form-input" placeholder="Bearer token" value="${esc(req.auth.bearer)}"></div>`;
    $('auth-bearer').oninput = e => { req.auth.bearer = e.target.value; };
  } else if (type === 'basic') {
    f.innerHTML = `<div class="form-row"><label>Username</label>
      <input type="text" id="auth-user" class="form-input" value="${esc(req.auth.username)}"></div>
      <div class="form-row"><label>Password</label>
      <input type="password" id="auth-pass" class="form-input" value="${esc(req.auth.password)}"></div>`;
    $('auth-user').oninput = e => { req.auth.username = e.target.value; };
    $('auth-pass').oninput = e => { req.auth.password = e.target.value; };
  } else {
    f.innerHTML = '<div class="empty-hint">未选择认证方式</div>';
  }
}

// ── Send request ──────────────────────────────────────────────────────────
async function sendRequest() {
  const url = $('url').value.trim();
  if (!url) { toast('请输入 URL', 'error'); return; }

  setLoading(true);
  clearResp();

  const headers = {};
  req.headers.filter(h => h.enabled && h.key).forEach(h => { headers[h.key] = h.value; });
  const params = {};
  req.params.filter(p => p.enabled && p.key).forEach(p => { params[p.key] = p.value; });

  const payload = {
    method: $('method').value,
    url,
    headers,
    params,
    body_mode: req.body.mode,
    body_raw: req.body.raw,
    body_form: req.body.formData,
    body_urlencoded: req.body.urlencoded,
    auth_type: req.auth.type,
    auth_bearer: req.auth.bearer,
    auth_username: req.auth.username,
    auth_password: req.auth.password,
    verify_ssl: $('verify-ssl').checked,
    use_sys_proxy: $('use-sys-proxy').checked,
  };

  try {
    const r = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      showError(`服务器错误 (${r.status}): ${text.slice(0, 300)}`);
      return;
    }
    if (!r.ok) { showError(data.detail || JSON.stringify(data)); }
    else { renderResp(data); }
  } catch(e) {
    showError(`网络错误: ${e.message}`);
  } finally {
    setLoading(false);
  }
}

// ── Response rendering ────────────────────────────────────────────────────
function renderResp(resp) {
  const s = resp.status;
  const statusEl = $('resp-status');
  statusEl.textContent = `${s} ${resp.status_text || ''}`;
  const cls = s < 200 ? '1xx' : s < 300 ? '2xx' : s < 400 ? '3xx' : s < 500 ? '4xx' : '5xx';
  statusEl.className = `badge badge-${cls}`;
  $('resp-time').textContent = `${resp.elapsed} ms`;
  $('resp-size').textContent = fmtBytes(resp.size);
  $('resp-stats').classList.remove('hidden');
  $('resp-body-toolbar').classList.remove('hidden');

  respBodyRaw = resp.body || '';
  renderRespBody();

  const hdrs = $('resp-headers-content');
  hdrs.innerHTML = '';
  Object.entries(resp.headers || {}).forEach(([k, v]) => {
    const row = document.createElement('div');
    row.className = 'resp-hdr-row';
    row.innerHTML = `<span class="resp-hdr-key">${esc(k)}</span><span class="resp-hdr-val">${esc(v)}</span>`;
    hdrs.appendChild(row);
  });
}

function renderRespBody() {
  const el = $('resp-body-content');
  if (!respBodyRaw) { el.innerHTML = '<div class="empty-hint">响应体为空</div>'; return; }
  if (!respPretty) { el.innerHTML = `<pre class="code-pre">${esc(respBodyRaw)}</pre>`; return; }
  try {
    const parsed = JSON.parse(respBodyRaw);
    el.innerHTML = `<pre class="code-pre">${jsonHL(JSON.stringify(parsed, null, 2))}</pre>`;
  } catch {
    el.innerHTML = `<pre class="code-pre">${esc(respBodyRaw)}</pre>`;
  }
}

function jsonHL(json) {
  json = json.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, m => {
    let c = 'jn';
    if (/^"/.test(m)) c = /:$/.test(m) ? 'jk' : 'js';
    else if (/true|false/.test(m)) c = 'jb';
    else if (/null/.test(m)) c = 'jnl';
    return `<span class="${c}">${m}</span>`;
  });
}

function setLoading(v) {
  const btn = $('btn-send');
  btn.disabled = v;
  btn.textContent = v ? 'Sending...' : 'Send';
  $('resp-loading').classList.toggle('hidden', !v);
}

function clearResp() {
  $('resp-stats').classList.add('hidden');
  $('resp-body-toolbar').classList.add('hidden');
  $('resp-body-content').innerHTML = '';
  $('resp-headers-content').innerHTML = '';
}

function showError(msg) {
  $('resp-body-content').innerHTML = `<div class="error-state">${esc(msg)}</div>`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1048576).toFixed(1)} MB`;
}

// ── Collections ───────────────────────────────────────────────────────────
async function loadCollections() {
  const r = await fetch('/api/collections');
  collections = await r.json();
  renderCollections();
}

function renderCollections() {
  const tree = $('collections-tree');
  if (!collections.length) { tree.innerHTML = '<div class="empty-hint">暂无 Collection</div>'; return; }
  tree.innerHTML = '';
  collections.forEach(col => tree.appendChild(buildColNode(col)));
}

function buildColNode(col) {
  const el = document.createElement('div');
  el.className = 'col-node';
  el.dataset.id = col.id;

  const header = document.createElement('div');
  header.className = 'col-header';
  header.innerHTML = `
    <span class="col-toggle">▶</span>
    <span class="col-icon">📁</span>
    <span class="col-name" title="${esc(col.name)}">${esc(col.name)}</span>
    <div class="col-actions">
      <button class="icon-btn" data-action="add" title="添加请求">+</button>
      <button class="icon-btn" data-action="more" title="更多">⋯</button>
    </div>`;

  const body = document.createElement('div');
  body.className = 'col-body hidden';
  (col.items || []).forEach(item => body.appendChild(buildItemNode(item, col.id)));

  header.querySelector('.col-toggle').addEventListener('click', () => {
    const open = !body.classList.contains('hidden');
    body.classList.toggle('hidden', open);
    header.querySelector('.col-toggle').textContent = open ? '▶' : '▼';
  });
  header.querySelector('[data-action="add"]').addEventListener('click', e => {
    e.stopPropagation(); openSaveDialog(col.id);
  });
  header.querySelector('[data-action="more"]').addEventListener('click', e => {
    e.stopPropagation(); showCtxMenu(e, col.id);
  });

  el.appendChild(header);
  el.appendChild(body);
  return el;
}

function buildItemNode(item, colId) {
  const el = document.createElement('div');
  if (item.type === 'folder') {
    el.className = 'folder-node';
    const header = document.createElement('div');
    header.className = 'folder-header';
    header.innerHTML = `
      <span class="folder-toggle">▶</span>
      <span>📂</span>
      <span class="folder-name" title="${esc(item.name)}">${esc(item.name)}</span>
      <div class="item-actions">
        <button class="icon-btn" data-action="del" title="删除">×</button>
      </div>`;
    const body = document.createElement('div');
    body.className = 'folder-body hidden';
    (item.items || []).forEach(child => body.appendChild(buildItemNode(child, colId)));
    header.querySelector('.folder-toggle').addEventListener('click', () => {
      const open = !body.classList.contains('hidden');
      body.classList.toggle('hidden', open);
      header.querySelector('.folder-toggle').textContent = open ? '▶' : '▼';
    });
    header.querySelector('[data-action="del"]').addEventListener('click', e => {
      e.stopPropagation(); deleteItem(colId, item.id);
    });
    el.appendChild(header);
    el.appendChild(body);
  } else {
    el.className = 'req-node';
    el.innerHTML = `
      <span class="method-badge ${(item.method||'GET').toLowerCase()}">${item.method||'GET'}</span>
      <span class="req-name-label" title="${esc(item.name)}">${esc(item.name)}</span>
      <div class="item-actions">
        <button class="icon-btn danger" data-action="del" title="删除">×</button>
      </div>`;
    el.addEventListener('click', e => {
      if (e.target.closest('[data-action]')) return;
      loadReqItem(item, colId);
    });
    el.querySelector('[data-action="del"]').addEventListener('click', e => {
      e.stopPropagation(); deleteItem(colId, item.id);
    });
  }
  return el;
}

function loadReqItem(item, colId) {
  currentItem = { colId, itemId: item.id };
  $('method').value = item.method || 'GET';
  $('url').value = item.url || '';
  $('req-name').value = item.name || '';
  req.url = item.url || '';
  req.params = item.params?.length ? JSON.parse(JSON.stringify(item.params)) : [kv()];
  req.headers = item.headers?.length ? JSON.parse(JSON.stringify(item.headers)) : [kv()];
  req.body = item.body ? JSON.parse(JSON.stringify(item.body)) : { mode: 'none', raw: '', rawType: 'json', formData: [kv()], urlencoded: [kv()] };
  req.auth = item.auth ? JSON.parse(JSON.stringify(item.auth)) : { type: 'none', bearer: '', username: '', password: '' };
  renderKV('params-editor', req.params, onParamsChange);
  renderKV('headers-editor', req.headers, () => {});
  $$('input[name="body-mode"]').forEach(r => { r.checked = r.value === req.body.mode; });
  renderBody();
  $('auth-type').value = req.auth.type;
  renderAuth();
  // Switch to active request tab
  activateTab('req-tabs', 'params');
}

// ── Collection CRUD ───────────────────────────────────────────────────────
async function createCollection(name) {
  const r = await fetch('/api/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, items: [] }),
  });
  const col = await r.json();
  collections.push(col);
  renderCollections();
  toast(`Collection "${name}" 已创建`, 'success');
}

async function saveColToServer(col) {
  await fetch(`/api/collections/${col.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(col),
  });
}

async function deleteCollection(id) {
  if (!confirm('确定删除该 Collection 及其所有请求？')) return;
  await fetch(`/api/collections/${id}`, { method: 'DELETE' });
  collections = collections.filter(c => c.id !== id);
  renderCollections();
  toast('已删除', 'success');
}

async function deleteItem(colId, itemId) {
  if (!confirm('确定删除？')) return;
  const col = collections.find(c => c.id === colId);
  if (!col) return;
  function remove(items) {
    const i = items.findIndex(x => x.id === itemId);
    if (i >= 0) { items.splice(i, 1); return true; }
    return items.some(x => x.type === 'folder' && remove(x.items || []));
  }
  remove(col.items);
  await saveColToServer(col);
  renderCollections();
  toast('已删除', 'success');
}

// ── Save request ──────────────────────────────────────────────────────────
function openSaveDialog(preColId) {
  const sel = $('save-col-select');
  sel.innerHTML = collections.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  if (preColId) sel.value = preColId;
  updateFolderSel();
  $('save-req-name').value = $('req-name').value || `${$('method').value} ${$('url').value.split('/').pop() || 'Request'}`;
  $('modal-save').classList.remove('hidden');
  $('save-req-name').focus();
  $('save-req-name').select();
}

function updateFolderSel() {
  const colId = $('save-col-select').value;
  const col = collections.find(c => c.id === colId);
  const sel = $('save-folder-select');
  sel.innerHTML = '<option value="">根目录</option>';
  (col?.items || []).filter(i => i.type === 'folder').forEach(f => {
    sel.innerHTML += `<option value="${f.id}">${esc(f.name)}</option>`;
  });
}

async function saveRequest() {
  const name = $('save-req-name').value.trim() || 'New Request';
  const colId = $('save-col-select').value;
  const folderId = $('save-folder-select').value;
  if (!colId) { toast('请选择 Collection', 'error'); return; }

  const col = collections.find(c => c.id === colId);
  if (!col) return;

  const item = buildReqItem(name);
  if (folderId) {
    const folder = col.items.find(i => i.id === folderId);
    if (folder) { folder.items = folder.items || []; folder.items.push(item); }
  } else {
    col.items.push(item);
  }

  await saveColToServer(col);
  renderCollections();
  currentItem = { colId, itemId: item.id };
  $('req-name').value = name;
  $('modal-save').classList.add('hidden');
  toast('已保存', 'success');
}

async function updateCurrentRequest() {
  if (!currentItem) { openSaveDialog(); return; }
  const col = collections.find(c => c.id === currentItem.colId);
  if (!col) return;

  function update(items) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === currentItem.itemId) {
        const name = $('req-name').value || items[i].name;
        const updated = buildReqItem(name);
        updated.id = currentItem.itemId;
        items[i] = updated;
        return true;
      }
      if (items[i].type === 'folder' && update(items[i].items || [])) return true;
    }
    return false;
  }

  if (update(col.items)) {
    await saveColToServer(col);
    renderCollections();
    toast('已更新', 'success');
  }
}

function buildReqItem(name) {
  return {
    id: uid(),
    type: 'request',
    name,
    method: $('method').value,
    url: $('url').value,
    headers: req.headers.filter(h => h.key),
    params: req.params.filter(p => p.key),
    body: JSON.parse(JSON.stringify(req.body)),
    auth: JSON.parse(JSON.stringify(req.auth)),
  };
}

// ── Context menu ──────────────────────────────────────────────────────────
function showCtxMenu(e, colId) {
  const menu = $('context-menu');
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 160) + 'px';
  menu.dataset.colId = colId;
  menu.classList.remove('hidden');
  const close = () => { menu.classList.add('hidden'); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
}

// ── History ───────────────────────────────────────────────────────────────
async function loadHistory() {
  const r = await fetch('/api/history');
  historyList = await r.json();
  renderHistory();
}

function renderHistory() {
  const list = $('history-list');
  if (!historyList.length) { list.innerHTML = '<div class="empty-hint">暂无历史记录</div>'; return; }
  list.innerHTML = '';
  historyList.slice(0, 50).forEach(entry => {
    const el = document.createElement('div');
    el.className = 'history-item';
    const sc = entry.status;
    const bcls = sc < 200 ? '1xx' : sc < 300 ? '2xx' : sc < 400 ? '3xx' : sc < 500 ? '4xx' : '5xx';
    el.innerHTML = `
      <div class="history-row1">
        <span class="method-badge ${entry.method.toLowerCase()}">${entry.method}</span>
        <span class="history-url">${esc(truncate(entry.url, 45))}</span>
      </div>
      <div class="history-row2">
        <span class="badge badge-${bcls}">${sc}</span>
        <span class="history-time">${entry.elapsed}ms</span>
        <span class="history-date">${fmtTime(entry.timestamp)}</span>
      </div>`;
    el.addEventListener('click', () => {
      if (entry.request) {
        const r2 = entry.request;
        $('method').value = r2.method;
        $('url').value = r2.url;
        req.url = r2.url;
        req.params = Object.entries(r2.params || {}).map(([k,v]) => ({ id: uid(), key: k, value: v, enabled: true }));
        if (!req.params.length) req.params.push(kv());
        req.headers = Object.entries(r2.headers || {}).map(([k,v]) => ({ id: uid(), key: k, value: v, enabled: true }));
        if (!req.headers.length) req.headers.push(kv());
        req.body = { mode: r2.body_mode||'none', raw: r2.body_raw||'', rawType: 'json',
          formData: r2.body_form||[kv()], urlencoded: r2.body_urlencoded||[kv()] };
        req.auth = { type: r2.auth_type||'none', bearer: r2.auth_bearer||'',
          username: r2.auth_username||'', password: r2.auth_password||'' };
        renderKV('params-editor', req.params, onParamsChange);
        renderKV('headers-editor', req.headers, () => {});
        $$('input[name="body-mode"]').forEach(rb => { rb.checked = rb.value === req.body.mode; });
        renderBody();
        $('auth-type').value = req.auth.type;
        renderAuth();
        currentItem = null;
      }
      if (entry.response) renderResp(entry.response);
      switchSidebar('collections');
    });
    list.appendChild(el);
  });
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString(); }

// ── Import / Export ───────────────────────────────────────────────────────
async function handleImport(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const r = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error('Import failed');
    const col = await r.json();
    const idx = collections.findIndex(c => c.id === col.id);
    if (idx >= 0) collections[idx] = col; else collections.push(col);
    renderCollections();
    toast(`已导入: ${col.name}`, 'success');
  } catch(e) {
    toast(`导入失败: ${e.message}`, 'error');
  }
}

async function exportCollection(colId) {
  const col = collections.find(c => c.id === colId);
  if (!col) return;
  try {
    const r = await fetch(`/api/export/${colId}`);
    const data = await r.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${col.name}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`已导出: ${col.name}`, 'success');
  } catch(e) {
    toast(`导出失败: ${e.message}`, 'error');
  }
}

// ── Sidebar panel switch ──────────────────────────────────────────────────
function switchSidebar(panel) {
  $$('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.panel === panel));
  $$('.sidebar-panel').forEach(p => p.classList.toggle('hidden', p.id !== `panel-${panel}`));
}

// ── Tab activation ────────────────────────────────────────────────────────
function activateTab(tabsId, tabName) {
  const container = $(tabsId);
  if (!container) return;
  container.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  const content = container.nextElementSibling;
  if (content?.classList.contains('tab-content')) {
    content.querySelectorAll('.tab-pane').forEach(p => {
      p.classList.toggle('hidden', p.id !== `pane-${tabName}`);
      p.classList.toggle('active', p.id === `pane-${tabName}`);
    });
  }
}

function initTabGroup(tabsId) {
  const container = $(tabsId);
  if (!container) return;
  container.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    activateTab(tabsId, tab.dataset.tab);
    if (tab.dataset.tab === 'body') renderBody();
    if (tab.dataset.tab === 'auth') renderAuth();
  });
}

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast toast-${type}`;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ── Modal helpers ─────────────────────────────────────────────────────────
function closeAllModals() { $$('.modal-overlay').forEach(m => m.classList.add('hidden')); }

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  renderKV('params-editor', req.params, onParamsChange);
  renderKV('headers-editor', req.headers, () => {});
  renderBody();
  renderAuth();
  initTabGroup('req-tabs');
  initTabGroup('resp-tabs');

  await Promise.all([loadCollections(), loadHistory()]);

  $('url').addEventListener('input', onUrlInput);

  $('btn-send').addEventListener('click', sendRequest);
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendRequest();
    if (e.key === 'Escape') closeAllModals();
  });

  $('btn-save-req').addEventListener('click', () => {
    currentItem ? updateCurrentRequest() : openSaveDialog();
  });

  $('btn-new-col').addEventListener('click', () => $('modal-new-col').classList.remove('hidden'));
  $('btn-create-col').addEventListener('click', async () => {
    const name = $('new-col-name').value.trim();
    if (!name) return;
    await createCollection(name);
    $('new-col-name').value = '';
    $('modal-new-col').classList.add('hidden');
  });
  $('new-col-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-create-col').click(); });

  $('save-col-select').addEventListener('change', updateFolderSel);
  $('btn-save-confirm').addEventListener('click', saveRequest);
  $('save-req-name').addEventListener('keydown', e => { if (e.key === 'Enter') saveRequest(); });

  $$('.modal-cancel').forEach(btn => btn.addEventListener('click', closeAllModals));
  $$('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) closeAllModals(); }));

  $('import-input').addEventListener('change', e => {
    if (e.target.files[0]) handleImport(e.target.files[0]);
    e.target.value = '';
  });

  $$('input[name="body-mode"]').forEach(r => {
    r.addEventListener('change', e => { req.body.mode = e.target.value; renderBody(); });
  });
  $('auth-type').addEventListener('change', e => { req.auth.type = e.target.value; renderAuth(); });

  $('btn-pretty').addEventListener('click', () => {
    respPretty = true;
    $('btn-pretty').classList.add('active');
    $('btn-raw-view').classList.remove('active');
    renderRespBody();
  });
  $('btn-raw-view').addEventListener('click', () => {
    respPretty = false;
    $('btn-raw-view').classList.add('active');
    $('btn-pretty').classList.remove('active');
    renderRespBody();
  });
  $('btn-copy-resp').addEventListener('click', () => {
    navigator.clipboard.writeText(respBodyRaw).then(() => toast('已复制', 'success'));
  });

  $('btn-clear-history').addEventListener('click', async () => {
    await fetch('/api/history', { method: 'DELETE' });
    historyList = [];
    renderHistory();
    toast('历史已清空', 'success');
  });

  $$('.sidebar-tab').forEach(t => t.addEventListener('click', () => switchSidebar(t.dataset.panel)));

  // Context menu actions
  $('ctx-export').addEventListener('click', () => {
    const id = $('context-menu').dataset.colId;
    if (id) exportCollection(id);
  });
  $('ctx-delete').addEventListener('click', () => {
    const id = $('context-menu').dataset.colId;
    if (id) deleteCollection(id);
  });
  $('ctx-add-request').addEventListener('click', () => {
    openSaveDialog($('context-menu').dataset.colId);
  });
  $('ctx-add-folder').addEventListener('click', () => {
    _pendingFolderColId = $('context-menu').dataset.colId;
    $('modal-new-folder').classList.remove('hidden');
  });
  $('ctx-rename').addEventListener('click', async () => {
    const id = $('context-menu').dataset.colId;
    const col = collections.find(c => c.id === id);
    if (!col) return;
    const name = prompt('重命名 Collection：', col.name);
    if (name?.trim()) {
      col.name = name.trim();
      await saveColToServer(col);
      renderCollections();
      toast('已重命名', 'success');
    }
  });

  $('btn-create-folder').addEventListener('click', async () => {
    const name = $('new-folder-name').value.trim();
    if (!name || !_pendingFolderColId) return;
    const col = collections.find(c => c.id === _pendingFolderColId);
    if (col) {
      col.items.push({ id: uid(), type: 'folder', name, items: [] });
      await saveColToServer(col);
      renderCollections();
      toast(`文件夹 "${name}" 已创建`, 'success');
    }
    $('new-folder-name').value = '';
    $('modal-new-folder').classList.add('hidden');
    _pendingFolderColId = null;
  });
  $('new-folder-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-create-folder').click(); });

  initResize();
}

// ── Resize panels ─────────────────────────────────────────────────────────
function initResize() {
  const sidebar        = document.querySelector('.sidebar');
  const requestSection = document.querySelector('.request-section');
  const workspace      = document.querySelector('.workspace');

  // 从 localStorage 恢复上次尺寸
  const savedSW = localStorage.getItem('layout.sidebarWidth');
  const savedRH = localStorage.getItem('layout.requestHeight');
  if (savedSW) { sidebar.style.width = savedSW; sidebar.style.minWidth = savedSW; }
  if (savedRH) { requestSection.style.flex = 'none'; requestSection.style.height = savedRH; }

  // 左右：侧边栏宽度
  $('resize-sidebar').addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebar.offsetWidth;
    const handle = $('resize-sidebar');
    handle.classList.add('active');
    document.body.classList.add('resizing', 'resizing-v');

    const onMove = e => {
      const w = Math.max(160, Math.min(520, startW + e.clientX - startX));
      sidebar.style.width = w + 'px';
      sidebar.style.minWidth = w + 'px';
    };
    const onUp = () => {
      handle.classList.remove('active');
      document.body.classList.remove('resizing', 'resizing-v');
      localStorage.setItem('layout.sidebarWidth', sidebar.style.width);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // 上下：请求区高度
  $('resize-panel').addEventListener('mousedown', e => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = requestSection.offsetHeight;
    const handle = $('resize-panel');
    handle.classList.add('active');
    document.body.classList.add('resizing', 'resizing-h');

    const onMove = e => {
      const total = workspace.offsetHeight;
      const h = Math.max(120, Math.min(total - 120, startH + e.clientY - startY));
      requestSection.style.flex = 'none';
      requestSection.style.height = h + 'px';
    };
    const onUp = () => {
      handle.classList.remove('active');
      document.body.classList.remove('resizing', 'resizing-h');
      localStorage.setItem('layout.requestHeight', requestSection.style.height);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

document.addEventListener('DOMContentLoaded', init);
