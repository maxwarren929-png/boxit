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
const MAX_AUTO_HASH_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;

let syncing = false;
let syncQueued = false;
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

function showStatus(message, tone = 'neutral', timeout = 5000) {
  statusText.textContent = message;
  statusEl.dataset.tone = tone;
  statusEl.classList.remove('hidden');
  if (timeout > 0) {
    setTimeout(() => {
      if (statusText.textContent === message) statusEl.classList.add('hidden');
    }, timeout);
  }
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
      <span id="qol-summary-copy" class="qol-summary-copy">Reading storage...</span>
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
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      document.querySelector('#qol-search').focus();
      return;
    }
    if (!typing && event.key === '/') {
      event.preventDefault();
      document.querySelector('#qol-search').focus();
    }
  });
}

function buildDialogs() {
  if (!document.querySelector('#qol-rename-dialog')) {
    const renameDialog = document.createElement('dialog');
    renameDialog.id = 'qol-rename-dialog';
    renameDialog.className = 'dialog qol-rename-dialog';
    renameDialog.innerHTML = `
      <form id="qol-rename-form" class="dialog-card">
        <div class="dialog-heading">
          <p class="dialog-kicker">Rename</p>
          <h2 id="qol-rename-title">Rename item</h2>
          <p id="qol-rename-current"></p>
        </div>
        <label class="field">
          <span>New name</span>
          <input id="qol-rename-input" type="text" maxlength="180" autocomplete="off" required>
        </label>
        <div class="dialog-actions">
          <button id="qol-rename-cancel" class="button button-secondary" type="button">Cancel</button>
          <button class="button button-primary" type="submit">Rename</button>
        </div>
      </form>
    `;
    document.body.append(renameDialog);

    renameDialog.querySelector('#qol-rename-cancel').addEventListener('click', () => renameDialog.close());
    renameDialog.addEventListener('click', event => {
      if (event.target === renameDialog) renameDialog.close();
    });
    renameDialog.addEventListener('close', () => {
      renameTarget = null;
    });
    renameDialog.querySelector('#qol-rename-form').addEventListener('submit', submitRename);
  }

  if (!document.querySelector('#qol-preview-dialog')) {
    const previewDialog = document.createElement('dialog');
    previewDialog.id = 'qol-preview-dialog';
    previewDialog.className = 'dialog qol-preview-dialog';
    previewDialog.innerHTML = `
      <div class="dialog-card qol-preview-card">
        <div class="dialog-heading">
          <p class="dialog-kicker">Preview</p>
          <h2 id="qol-preview-title">File preview</h2>
          <p id="qol-preview-detail"></p>
        </div>
        <div id="qol-preview-body" class="qol-preview-body"></div>
        <div class="dialog-actions">
          <button id="qol-preview-close" class="button button-secondary" type="button">Close</button>
        </div>
      </div>
    `;
    document.body.append(previewDialog);

    previewDialog.querySelector('#qol-preview-close').addEventListener('click', () => previewDialog.close());
    previewDialog.addEventListener('click', event => {
      if (event.target === previewDialog) previewDialog.close();
    });
    previewDialog.addEventListener('close', clearPreview);
  }
}

async function submitRename(event) {
  event.preventDefault();
  if (!renameTarget) return;
  const input = document.querySelector('#qol-rename-input');
  const name = input.value.trim();
  if (!name) {
    input.focus();
    return;
  }

  try {
    if (renameTarget.kind === 'box') await renameBox(renameTarget.id, name);
    else await renameFile(renameTarget.id, name);
    document.querySelector('#qol-rename-dialog').close();
    window.location.reload();
  } catch (error) {
    showStatus(error?.message || 'BoxIt could not rename that item.', 'error', 7000);
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
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function clearPreview() {
  if (activePreviewUrl) URL.revokeObjectURL(activePreviewUrl);
  activePreviewUrl = null;
  document.querySelector('#qol-preview-body')?.replaceChildren();
}

function isTextType(record) {
  const type = String(record.type || '').toLowerCase();
  const name = String(record.name || '').toLowerCase();
  return type.startsWith('text/') ||
    type.includes('json') ||
    type.includes('javascript') ||
    type.includes('xml') ||
    /\.(txt|md|json|csv|tsv|js|mjs|cjs|ts|tsx|jsx|css|html|htm|xml|yaml|yml|toml|ini|log)$/i.test(name);
}

function isPreviewable(record) {
  const type = String(record.type || '').toLowerCase();
  return type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/') || type === 'application/pdf' || isTextType(record);
}

async function openPreview(fileId) {
  const record = await getFile(fileId);
  if (!record) {
    showStatus('That file is no longer available in BoxIt.', 'error');
    return;
  }

  clearPreview();
  const dialog = document.querySelector('#qol-preview-dialog');
  const title = document.querySelector('#qol-preview-title');
  const detail = document.querySelector('#qol-preview-detail');
  const body = document.querySelector('#qol-preview-body');
  const type = String(record.type || '').toLowerCase();

  title.textContent = record.name;
  detail.textContent = `${formatBytes(record.size)} · ${record.type || 'Unknown type'}`;

  if (type.startsWith('image/')) {
    activePreviewUrl = URL.createObjectURL(record.blob);
    const image = document.createElement('img');
    image.className = 'qol-preview-image';
    image.src = activePreviewUrl;
    image.alt = record.name;
    body.append(image);
  } else if (isTextType(record)) {
    const previewBlob = record.blob.slice(0, MAX_TEXT_PREVIEW_BYTES);
    const text = await previewBlob.text();
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
  } else if (type.startsWith('audio/')) {
    activePreviewUrl = URL.createObjectURL(record.blob);
    const audio = document.createElement('audio');
    audio.className = 'qol-preview-media';
    audio.src = activePreviewUrl;
    audio.controls = true;
    body.append(audio);
  } else if (type.startsWith('video/')) {
    activePreviewUrl = URL.createObjectURL(record.blob);
    const video = document.createElement('video');
    video.className = 'qol-preview-media';
    video.src = activePreviewUrl;
    video.controls = true;
    body.append(video);
  } else {
    const meta = document.createElement('div');
    meta.className = 'qol-preview-meta';
    const name = document.createElement('strong');
    const size = document.createElement('span');
    const mime = document.createElement('span');
    name.textContent = record.name;
    size.textContent = formatBytes(record.size);
    mime.textContent = record.type || 'Unknown type';
    meta.append(name, size, mime);
    body.append(meta);
  }

  dialog.showModal();
}

async function digestRecord(record) {
  if (record.hash) return record.hash;
  if (!record.blob || record.size > MAX_AUTO_HASH_BYTES) return null;
  const buffer = await record.blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  await setFileHash(record.id, hash);
  record.hash = hash;
  return hash;
}

async function findDuplicates(files) {
  const candidates = new Map();
  for (const file of files) {
    if (!file.size || file.size > MAX_AUTO_HASH_BYTES) continue;
    const key = `${file.boxId}:${file.size}`;
    const group = candidates.get(key) || [];
    group.push(file);
    candidates.set(key, group);
  }

  const duplicateMap = new Map();
  for (const group of candidates.values()) {
    if (group.length < 2) continue;
    const hashes = new Map();
    for (const file of group) {
      try {
        const hash = await digestRecord(file);
        if (!hash) continue;
        const list = hashes.get(hash) || [];
        list.push(file);
        hashes.set(hash, list);
      } catch {
        // Duplicate detection is a convenience feature and should never block the popup.
      }
    }

    for (const matches of hashes.values()) {
      if (matches.length < 2) continue;
      const sorted = [...matches].sort((a, b) => a.createdAt - b.createdAt);
      for (const file of sorted) duplicateMap.set(file.id, sorted);
    }
  }
  return duplicateMap;
}

function recordsByBox(files) {
  const map = new Map();
  for (const file of files) {
    const list = map.get(file.boxId) || [];
    list.push(file);
    map.set(file.boxId, list);
  }
  return map;
}

function syncActionButtons(card, box, files) {
  const deleteButton = card.querySelector('.delete-box');
  let actions = card.querySelector('.box-head-actions');
  if (!actions && deleteButton) {
    actions = document.createElement('div');
    actions.className = 'box-head-actions';
    deleteButton.before(actions);
    actions.append(deleteButton);
  }

  if (actions && !actions.querySelector('.qol-rename-box')) {
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'button button-ghost qol-rename-box';
    rename.textContent = 'Rename';
    rename.addEventListener('click', () => openRename('box', box.id, box.name));
    actions.insertBefore(rename, actions.firstChild);
  }

  const rows = [...card.querySelectorAll('.file-row')];
  for (let index = 0; index < Math.min(files.length, rows.length); index += 1) {
    const record = files[index];
    const row = rows[index];
    row.dataset.qolFileId = record.id;

    const actionsEl = row.querySelector('.file-actions');
    if (actionsEl && !actionsEl.querySelector('.qol-rename-file')) {
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'button button-file qol-rename-file';
      rename.textContent = 'Rename';
      rename.addEventListener('click', () => openRename('file', record.id, record.name));
      actionsEl.insertBefore(rename, actionsEl.querySelector('.delete-file'));
    }

    if (isPreviewable(record) && actionsEl && !actionsEl.querySelector('.qol-preview-file')) {
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'button button-file qol-preview-file';
      preview.textContent = 'Preview';
      preview.addEventListener('click', () => openPreview(record.id));
      actionsEl.insertBefore(preview, actionsEl.firstChild);
      row.classList.add('qol-file-previewable');
      row.querySelector('.file-icon')?.addEventListener('click', () => openPreview(record.id));
      row.querySelector('.file-copy')?.addEventListener('dblclick', () => openPreview(record.id));
    }

    const copy = row.querySelector('.file-copy');
    const existing = copy?.querySelector('.qol-duplicate-tag');
    const duplicates = state.duplicates.get(record.id);
    if (duplicates?.length > 1) {
      const tag = existing || document.createElement('span');
      tag.className = 'qol-duplicate-tag';
      tag.textContent = `Duplicate ×${duplicates.length}`;
      if (!existing) copy?.append(tag);
    } else {
      existing?.remove();
    }
  }
}

function rankMap(items, compare) {
  const sorted = [...items].sort(compare);
  return new Map(sorted.map((item, index) => [item.id, index]));
}

function applyViewState() {
  const search = String(document.querySelector('#qol-search')?.value || '').trim().toLowerCase();
  const sort = document.querySelector('#qol-sort')?.value || 'default';
  const filesByBox = recordsByBox(state.files);
  let visibleBoxes = 0;

  const boxTotals = new Map();
  for (const box of state.boxes) {
    boxTotals.set(box.id, (filesByBox.get(box.id) || []).reduce((sum, file) => sum + Number(file.size || 0), 0));
  }

  let boxRanks = new Map(state.boxes.map((box, index) => [box.id, index]));
  if (sort === 'recent') boxRanks = rankMap(state.boxes, (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  if (sort === 'name') boxRanks = rankMap(state.boxes, (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (sort === 'size') boxRanks = rankMap(state.boxes, (a, b) => Number(boxTotals.get(b.id) || 0) - Number(boxTotals.get(a.id) || 0));

  const cards = [...boxesEl.querySelectorAll('.box-card')];
  for (let index = 0; index < Math.min(cards.length, state.boxes.length); index += 1) {
    const card = cards[index];
    const box = state.boxes[index];
    const files = filesByBox.get(box.id) || [];
    card.dataset.qolBoxId = box.id;
    card.style.order = String(boxRanks.get(box.id) ?? index);

    let fileRanks = new Map(files.map((file, fileIndex) => [file.id, fileIndex]));
    if (sort === 'recent') fileRanks = rankMap(files, (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    if (sort === 'name') fileRanks = rankMap(files, (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    if (sort === 'size') fileRanks = rankMap(files, (a, b) => Number(b.size || 0) - Number(a.size || 0));

    const boxMatches = !search || box.name.toLowerCase().includes(search);
    let matchingFiles = 0;
    const rows = [...card.querySelectorAll('.file-row')];
    for (let fileIndex = 0; fileIndex < Math.min(rows.length, files.length); fileIndex += 1) {
      const row = rows[fileIndex];
      const file = files[fileIndex];
      const fileMatches = !search || file.name.toLowerCase().includes(search) || String(file.type || '').toLowerCase().includes(search);
      const visible = boxMatches || fileMatches;
      row.classList.toggle('hidden', !visible);
      if (visible) matchingFiles += 1;
      row.style.order = String(fileRanks.get(file.id) ?? fileIndex);
    }

    const shouldShow = boxMatches || matchingFiles > 0;
    card.classList.toggle('hidden', !shouldShow);
    if (shouldShow) visibleBoxes += 1;
  }

  document.querySelector('#qol-no-results')?.classList.toggle('hidden', visibleBoxes > 0 || !search);
}

async function updateSummary() {
  const totalBytes = state.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  let redundantFiles = 0;

  for (const [fileId, group] of state.duplicates) {
    if (!group?.length) continue;
    const oldest = [...group].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (fileId !== oldest.id) redundantFiles += 1;
  }

  let quotaCopy = '';
  try {
    const estimate = await navigator.storage.estimate();
    if (estimate.quota && estimate.usage) {
      const percent = Math.min(100, (estimate.usage / estimate.quota) * 100);
      quotaCopy = ` · ${percent.toFixed(percent < 1 ? 1 : 0)}% browser quota`;
    }
  } catch {
    // Exact BoxIt blob size is still shown even when quota estimation is unavailable.
  }

  const duplicateCopy = redundantFiles ? ` · ${redundantFiles} removable duplicate${redundantFiles === 1 ? '' : 's'}` : '';
  document.querySelector('#qol-summary-copy').textContent = `${state.files.length} file${state.files.length === 1 ? '' : 's'} · ${formatBytes(totalBytes)} stored${duplicateCopy}${quotaCopy}`;

  const cleanButton = document.querySelector('#qol-clean');
  cleanButton.classList.toggle('hidden', redundantFiles === 0);
  cleanButton.textContent = redundantFiles ? `Remove ${redundantFiles} duplicate${redundantFiles === 1 ? '' : 's'}` : 'Remove duplicates';
}

async function removeDuplicates() {
  const remove = new Set();

  for (const group of state.duplicates.values()) {
    if (!group?.length) continue;
    const sorted = [...group].sort((a, b) => a.createdAt - b.createdAt);
    for (const file of sorted.slice(1)) remove.add(file.id);
  }

  if (!remove.size) return;
  if (!confirm(`Remove ${remove.size} exact duplicate file${remove.size === 1 ? '' : 's'}? The oldest copy in each box will be kept.`)) return;

  try {
    for (const fileId of remove) await deleteFile(fileId);
    showStatus(`Removed ${remove.size} duplicate file${remove.size === 1 ? '' : 's'}.`, 'success');
    window.location.reload();
  } catch (error) {
    showStatus(error?.message || 'BoxIt could not remove duplicate files.', 'error', 7000);
  }
}

function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  setTimeout(async () => {
    syncQueued = false;
    await syncQol();
  }, 40);
}

async function syncQol() {
  if (syncing) return;
  syncing = true;
  try {
    const [boxes, files] = await Promise.all([listBoxes(), listAllFiles()]);
    const duplicates = await findDuplicates(files);
    state = { boxes, files, duplicates };

    const filesByBox = recordsByBox(files);
    const cards = [...boxesEl.querySelectorAll('.box-card')];
    for (let index = 0; index < Math.min(boxes.length, cards.length); index += 1) {
      syncActionButtons(cards[index], boxes[index], filesByBox.get(boxes[index].id) || []);
    }

    applyViewState();
    await updateSummary();
  } finally {
    syncing = false;
  }
}

buildToolbar();
buildDialogs();

const observer = new MutationObserver(queueSync);
observer.observe(boxesEl, { childList: true, subtree: true });

await syncQol();
