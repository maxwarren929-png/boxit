import {
  listBoxes,
  listAllFiles,
  getFile,
  renameBox,
  renameFile,
  setFileHash,
  deleteFile
} from './db.js';

const boxesEl = document.querySelector('#boxes');
const appHeader = document.querySelector('.app-header');
const statusEl = document.querySelector('#use-status');
const statusText = document.querySelector('#use-status-text');
const MAX_AUTO_HASH_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;

let syncing = false;
let dirty = false;
let duplicateJob = 0;
let state = { boxes: [], files: [], duplicates: new Map() };
let activePreviewUrl = null;
let renameTarget = null;

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function showStatus(message, tone = 'neutral') {
  statusText.textContent = message;
  statusEl.dataset.tone = tone;
  statusEl.classList.remove('hidden');
}

function buildToolbar() {
  if (document.querySelector('#qol-toolbar')) return;
  const toolbar = document.createElement('section');
  toolbar.id = 'qol-toolbar';
  toolbar.className = 'qol-toolbar';
  toolbar.innerHTML = `
    <label class="qol-search-wrap">
      <input id="qol-search" class="qol-search" type="search" autocomplete="off" placeholder="Search boxes and files">
    </label>
    <select id="qol-sort" class="qol-sort" aria-label="Sort boxes and files">
      <option value="default">Default order</option>
      <option value="recent">Most recent</option>
      <option value="name">Name A–Z</option>
      <option value="size">Largest first</option>
    </select>
    <div class="qol-summary">
      <span id="qol-summary-copy" class="qol-summary-copy">Reading storage…</span>
      <button id="qol-clean" class="button qol-clean hidden" type="button">Remove duplicates</button>
    </div>
  `;
  appHeader.after(toolbar);
  const noResults = document.createElement('div');
  noResults.id = 'qol-no-results';
  noResults.className = 'qol-no-results hidden';
  noResults.textContent = 'No boxes or files match that search.';
  boxesEl.after(noResults);

  document.querySelector('#qol-search').addEventListener('input', applyViewState);
  document.querySelector('#qol-sort').addEventListener('change', applyViewState);
  document.querySelector('#qol-clean').addEventListener('click', removeDuplicates);
  document.addEventListener('keydown', event => {
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      document.querySelector('#qol-search').focus();
    } else if (!typing && event.key === '/') {
      event.preventDefault();
      document.querySelector('#qol-search').focus();
    }
  });
}

function buildDialogs() {
  const rename = document.createElement('dialog');
  rename.id = 'qol-rename-dialog';
  rename.className = 'dialog qol-rename-dialog';
  rename.innerHTML = `
    <form id="qol-rename-form" class="dialog-card">
      <div class="dialog-heading">
        <p class="dialog-kicker">Rename</p>
        <h2 id="qol-rename-title">Rename item</h2>
        <p id="qol-rename-current"></p>
      </div>
      <label class="field"><span>New name</span><input id="qol-rename-input" type="text" maxlength="180" autocomplete="off" required></label>
      <div class="dialog-actions">
        <button id="qol-rename-cancel" class="button button-secondary" type="button">Cancel</button>
        <button class="button button-primary" type="submit">Rename</button>
      </div>
    </form>`;
  document.body.append(rename);
  rename.querySelector('#qol-rename-cancel').addEventListener('click', () => rename.close());
  rename.addEventListener('click', event => { if (event.target === rename) rename.close(); });
  rename.addEventListener('close', () => { renameTarget = null; });
  rename.querySelector('#qol-rename-form').addEventListener('submit', submitRename);

  const preview = document.createElement('dialog');
  preview.id = 'qol-preview-dialog';
  preview.className = 'dialog qol-preview-dialog';
  preview.innerHTML = `
    <div class="dialog-card qol-preview-card">
      <div class="dialog-heading">
        <p class="dialog-kicker">Preview</p>
        <h2 id="qol-preview-title">File preview</h2>
        <p id="qol-preview-detail"></p>
      </div>
      <div id="qol-preview-body" class="qol-preview-body"></div>
      <div class="dialog-actions"><button id="qol-preview-close" class="button button-secondary" type="button">Close</button></div>
    </div>`;
  document.body.append(preview);
  preview.querySelector('#qol-preview-close').addEventListener('click', () => preview.close());
  preview.addEventListener('click', event => { if (event.target === preview) preview.close(); });
  preview.addEventListener('close', clearPreview);
}

async function submitRename(event) {
  event.preventDefault();
  if (!renameTarget) return;
  const input = document.querySelector('#qol-rename-input');
  const name = input.value.trim();
  if (!name) return input.focus();
  try {
    if (renameTarget.kind === 'box') await renameBox(renameTarget.id, name);
    else await renameFile(renameTarget.id, name);
    window.location.reload();
  } catch (error) {
    showStatus(error?.message || 'BoxIt could not rename that item.', 'error');
  }
}

function openRename(kind, id, currentName) {
  renameTarget = { kind, id };
  const dialog = document.querySelector('#qol-rename-dialog');
  const input = document.querySelector('#qol-rename-input');
  document.querySelector('#qol-rename-title').textContent = kind === 'box' ? 'Rename box' : 'Rename file';
  document.querySelector('#qol-rename-current').textContent = currentName;
  input.maxLength = kind === 'box' ? 48 : 180;
  input.value = currentName;
  dialog.showModal();
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

function clearPreview() {
  if (activePreviewUrl) URL.revokeObjectURL(activePreviewUrl);
  activePreviewUrl = null;
  document.querySelector('#qol-preview-body')?.replaceChildren();
}

function isTextType(record) {
  const type = String(record.type || '').toLowerCase();
  const name = String(record.name || '').toLowerCase();
  return type.startsWith('text/') || type.includes('json') || type.includes('javascript') || type.includes('xml') ||
    /\.(txt|md|json|csv|tsv|js|mjs|cjs|ts|tsx|jsx|css|html|htm|xml|yaml|yml|toml|ini|log)$/i.test(name);
}

function isPreviewable(record) {
  const type = String(record.type || '').toLowerCase();
  return type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/') || type === 'application/pdf' || isTextType(record);
}

async function openPreview(fileId) {
  const record = await getFile(fileId);
  if (!record) return showStatus('That file is no longer available in BoxIt.', 'error');
  clearPreview();
  const dialog = document.querySelector('#qol-preview-dialog');
  const body = document.querySelector('#qol-preview-body');
  const type = String(record.type || '').toLowerCase();
  document.querySelector('#qol-preview-title').textContent = record.name;
  document.querySelector('#qol-preview-detail').textContent = `${formatBytes(record.size)} · ${record.type || 'Unknown type'}`;

  if (type.startsWith('image/')) {
    activePreviewUrl = URL.createObjectURL(record.blob);
    const image = document.createElement('img');
    image.className = 'qol-preview-image';
    image.src = activePreviewUrl;
    image.alt = record.name;
    body.append(image);
  } else if (isTextType(record)) {
    const text = await record.blob.slice(0, MAX_TEXT_PREVIEW_BYTES).text();
    const pre = document.createElement('pre');
    pre.className = 'qol-preview-text';
    pre.textContent = `${text}${record.size > MAX_TEXT_PREVIEW_BYTES ? '\n\n[Preview truncated]' : ''}`;
    body.append(pre);
  } else if (type === 'application/pdf') {
    activePreviewUrl = URL.createObjectURL(record.blob);
    const frame = document.createElement('iframe');
    frame.className = 'qol-preview-frame';
    frame.src = activePreviewUrl;
    frame.title = record.name;
    body.append(frame);
  } else if (type.startsWith('audio/') || type.startsWith('video/')) {
    activePreviewUrl = URL.createObjectURL(record.blob);
    const media = document.createElement(type.startsWith('audio/') ? 'audio' : 'video');
    media.className = 'qol-preview-media';
    media.src = activePreviewUrl;
    media.controls = true;
    body.append(media);
  }
  dialog.showModal();
}

function recordsByBox(files) {
  const map = new Map();
  for (const file of files) {
    const group = map.get(file.boxId) || [];
    group.push(file);
    map.set(file.boxId, group);
  }
  return map;
}

function rankMap(items, compare) {
  const sorted = [...items].sort(compare);
  return new Map(sorted.map((item, index) => [item.id, index]));
}

function applyViewState() {
  const search = String(document.querySelector('#qol-search')?.value || '').trim().toLowerCase();
  const sort = document.querySelector('#qol-sort')?.value || 'default';
  const byBox = recordsByBox(state.files);
  const totals = new Map(state.boxes.map(box => [box.id, (byBox.get(box.id) || []).reduce((sum, f) => sum + Number(f.size || 0), 0)]));
  let boxRanks = new Map(state.boxes.map((box, i) => [box.id, i]));
  if (sort === 'recent') boxRanks = rankMap(state.boxes, (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  if (sort === 'name') boxRanks = rankMap(state.boxes, (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (sort === 'size') boxRanks = rankMap(state.boxes, (a, b) => Number(totals.get(b.id) || 0) - Number(totals.get(a.id) || 0));

  let visibleBoxes = 0;
  const cards = [...boxesEl.querySelectorAll('.box-card')];
  for (let i = 0; i < Math.min(cards.length, state.boxes.length); i += 1) {
    const card = cards[i];
    const box = state.boxes[i];
    const files = byBox.get(box.id) || [];
    card.style.order = String(boxRanks.get(box.id) ?? i);
    const rows = [...card.querySelectorAll('.file-row')];
    let fileRanks = new Map(files.map((file, j) => [file.id, j]));
    if (sort === 'recent') fileRanks = rankMap(files, (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    if (sort === 'name') fileRanks = rankMap(files, (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    if (sort === 'size') fileRanks = rankMap(files, (a, b) => Number(b.size || 0) - Number(a.size || 0));
    const boxMatches = !search || box.name.toLowerCase().includes(search);
    let matching = 0;
    for (let j = 0; j < Math.min(rows.length, files.length); j += 1) {
      const row = rows[j];
      const file = files[j];
      row.style.order = String(fileRanks.get(file.id) ?? j);
      const fileMatches = !search || file.name.toLowerCase().includes(search) || String(file.type || '').toLowerCase().includes(search);
      const visible = boxMatches || fileMatches;
      row.classList.toggle('hidden', !visible);
      if (visible) matching += 1;
    }
    const visible = boxMatches || matching > 0;
    card.classList.toggle('hidden', !visible);
    if (visible) visibleBoxes += 1;
  }
  document.querySelector('#qol-no-results')?.classList.toggle('hidden', visibleBoxes > 0 || !search);
}

function decorateControls() {
  const byBox = recordsByBox(state.files);
  const cards = [...boxesEl.querySelectorAll('.box-card')];
  for (let i = 0; i < Math.min(cards.length, state.boxes.length); i += 1) {
    const card = cards[i];
    const box = state.boxes[i];
    const deleteButton = card.querySelector('.delete-box');
    let actions = card.querySelector('.box-head-actions');
    if (!actions && deleteButton) {
      actions = document.createElement('div');
      actions.className = 'box-head-actions';
      deleteButton.before(actions);
      actions.append(deleteButton);
    }
    if (actions && !actions.querySelector('.qol-rename-box')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button-ghost qol-rename-box';
      button.textContent = 'Rename';
      button.addEventListener('click', () => openRename('box', box.id, box.name));
      actions.insertBefore(button, actions.firstChild);
    }

    const files = byBox.get(box.id) || [];
    const rows = [...card.querySelectorAll('.file-row')];
    for (let j = 0; j < Math.min(rows.length, files.length); j += 1) {
      const row = rows[j];
      const file = files[j];
      row.dataset.qolFileId = file.id;
      const actionsEl = row.querySelector('.file-actions');
      if (actionsEl && !actionsEl.querySelector('.qol-rename-file')) {
        const rename = document.createElement('button');
        rename.type = 'button';
        rename.className = 'button button-file qol-rename-file';
        rename.textContent = 'Rename';
        rename.addEventListener('click', () => openRename('file', file.id, file.name));
        actionsEl.insertBefore(rename, actionsEl.querySelector('.delete-file'));
      }
      if (isPreviewable(file) && actionsEl && !actionsEl.querySelector('.qol-preview-file')) {
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'button button-file qol-preview-file';
        preview.textContent = 'Preview';
        preview.addEventListener('click', () => openPreview(file.id));
        actionsEl.insertBefore(preview, actionsEl.firstChild);
      }
    }
  }
}

function decorateDuplicates() {
  for (const row of boxesEl.querySelectorAll('.file-row')) {
    const fileId = row.dataset.qolFileId;
    const copy = row.querySelector('.file-copy');
    const existing = copy?.querySelector('.qol-duplicate-tag');
    const group = state.duplicates.get(fileId);
    if (group?.length > 1) {
      const tag = existing || document.createElement('span');
      tag.className = 'qol-duplicate-tag';
      tag.textContent = `Duplicate ×${group.length}`;
      if (!existing) copy?.append(tag);
    } else existing?.remove();
  }
}

async function updateSummary() {
  const total = state.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  const remove = new Set();
  for (const group of state.duplicates.values()) {
    const sorted = [...group].sort((a, b) => a.createdAt - b.createdAt);
    for (const file of sorted.slice(1)) remove.add(file.id);
  }
  let quota = '';
  try {
    const estimate = await navigator.storage.estimate();
    if (estimate.quota && estimate.usage) {
      const percent = Math.min(100, (estimate.usage / estimate.quota) * 100);
      quota = ` · ${percent.toFixed(percent < 1 ? 1 : 0)}% browser quota`;
    }
  } catch {}
  const dup = remove.size ? ` · ${remove.size} removable duplicate${remove.size === 1 ? '' : 's'}` : '';
  document.querySelector('#qol-summary-copy').textContent = `${state.files.length} file${state.files.length === 1 ? '' : 's'} · ${formatBytes(total)} stored${dup}${quota}`;
  const button = document.querySelector('#qol-clean');
  button.classList.toggle('hidden', remove.size === 0);
  button.textContent = remove.size ? `Remove ${remove.size} duplicate${remove.size === 1 ? '' : 's'}` : 'Remove duplicates';
}

async function digestRecord(record) {
  if (record.hash) return record.hash;
  if (!record.blob || record.size > MAX_AUTO_HASH_BYTES) return null;
  const digest = await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer());
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  await setFileHash(record.id, hash);
  record.hash = hash;
  return hash;
}

async function scanDuplicates(job) {
  const candidates = new Map();
  for (const file of state.files) {
    const key = `${file.boxId}:${file.size}`;
    const group = candidates.get(key) || [];
    group.push(file);
    candidates.set(key, group);
  }
  const duplicates = new Map();
  for (const group of candidates.values()) {
    if (job !== duplicateJob) return;
    if (group.length < 2) continue;
    const hashes = new Map();
    for (const file of group) {
      if (job !== duplicateJob) return;
      const hash = await digestRecord(file).catch(() => null);
      if (hash) {
        const matches = hashes.get(hash) || [];
        matches.push(file);
        hashes.set(hash, matches);
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    for (const matches of hashes.values()) {
      if (matches.length < 2) continue;
      const sorted = [...matches].sort((a, b) => a.createdAt - b.createdAt);
      for (const file of sorted) duplicates.set(file.id, sorted);
    }
  }
  if (job !== duplicateJob) return;
  state.duplicates = duplicates;
  decorateDuplicates();
  await updateSummary();
}

function scheduleDuplicateScan() {
  const job = ++duplicateJob;
  const start = () => scanDuplicates(job).catch(() => {});
  if ('requestIdleCallback' in window) window.requestIdleCallback(start, { timeout: 600 });
  else setTimeout(start, 250);
}

async function removeDuplicates() {
  const remove = new Set();
  for (const group of state.duplicates.values()) {
    const sorted = [...group].sort((a, b) => a.createdAt - b.createdAt);
    for (const file of sorted.slice(1)) remove.add(file.id);
  }
  if (!remove.size) return;
  if (!confirm(`Remove ${remove.size} exact duplicate file${remove.size === 1 ? '' : 's'}? The oldest copy in each box will be kept.`)) return;
  try {
    for (const id of remove) await deleteFile(id);
    window.location.reload();
  } catch (error) {
    showStatus(error?.message || 'BoxIt could not remove duplicate files.', 'error');
  }
}

async function syncQol() {
  if (syncing) {
    dirty = true;
    return;
  }
  syncing = true;
  try {
    const [boxes, files] = await Promise.all([listBoxes(), listAllFiles()]);
    state = { boxes, files, duplicates: state.duplicates };
    decorateControls();
    applyViewState();
    decorateDuplicates();
    await updateSummary();
    scheduleDuplicateScan();
  } finally {
    syncing = false;
    if (dirty) {
      dirty = false;
      queueMicrotask(syncQol);
    }
  }
}

buildToolbar();
buildDialogs();
const observer = new MutationObserver(() => syncQol());
observer.observe(boxesEl, { childList: true, subtree: true });
await syncQol();