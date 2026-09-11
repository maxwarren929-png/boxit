import { addFiles, getBox, getFile, listBoxes, listFiles } from './db.js';

const boxesEl = document.querySelector('#boxes');
const targetDialog = document.querySelector('#target-dialog');
const targetList = document.querySelector('#target-list');
const targetFileName = document.querySelector('#target-file-name');
const cancelTargetButton = document.querySelector('#cancel-target');
const statusEl = document.querySelector('#use-status');
const statusText = document.querySelector('#use-status-text');

const CHUNK_BYTES = 256 * 1024;
const MAX_USE_BYTES = 256 * 1024 * 1024;
let pendingTarget = null;
let mappingSync = false;
let mappingDirty = false;
let lastShape = '';
let nudgeTimer = null;

function showStatus(message, tone = 'neutral', action = null) {
  statusText.textContent = message;
  statusEl.dataset.tone = tone;
  statusEl.classList.remove('hidden');
  statusEl.querySelector('.safe-status-action')?.remove();
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-secondary safe-status-action';
    button.textContent = action.label;
    button.addEventListener('click', action.onClick, { once: true });
    statusEl.append(button);
  }
}

function isMissingReceiver(error) {
  const message = String(error?.message || error || '');
  return message.includes('Receiving end does not exist') || message.includes('Could not establish connection');
}

async function sendToPage(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    if (response !== undefined) return response;
  } catch (error) {
    if (!isMissingReceiver(error)) throw error;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['transfer-content.js', 'content.js'] });
  } catch {
    throw new Error('This page does not allow BoxIt to access upload controls.');
  }
  const response = await chrome.tabs.sendMessage(tabId, message);
  if (response === undefined) throw new Error('BoxIt could not connect to this page.');
  return response;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('BoxIt could not find the current tab.');
  return tab;
}

async function hydrateMappings() {
  if (mappingSync) {
    mappingDirty = true;
    return;
  }
  mappingSync = true;
  try {
    const boxes = await listBoxes();
    const cards = [...boxesEl.querySelectorAll('.box-card')];
    for (let index = 0; index < Math.min(boxes.length, cards.length); index += 1) {
      const box = boxes[index];
      const card = cards[index];
      card.dataset.safeBoxId = box.id;
      const files = await listFiles(box.id);
      const rows = [...card.querySelectorAll('.file-row')];
      for (let fileIndex = 0; fileIndex < Math.min(files.length, rows.length); fileIndex += 1) {
        rows[fileIndex].dataset.safeFileId = files[fileIndex].id;
      }
    }
  } finally {
    mappingSync = false;
    if (mappingDirty) {
      mappingDirty = false;
      queueMicrotask(hydrateMappings);
    }
  }
}

function scheduleObserverNudge() {
  const shape = `${boxesEl.querySelectorAll('.box-card').length}:${boxesEl.querySelectorAll('.file-row').length}`;
  if (shape === lastShape) return;
  lastShape = shape;
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => {
    const marker = document.createComment('boxit-resync');
    boxesEl.append(marker);
    setTimeout(() => marker.remove(), 0);
  }, 140);
}

async function discoverTargets(record, tabId) {
  const response = await sendToPage(tabId, {
    type: 'BOXIT_GET_TARGETS_V3',
    file: { name: record.name, type: record.type, size: record.size, lastModified: record.lastModified }
  });
  if (!response?.ok) throw new Error(response?.error || 'BoxIt could not inspect this page.');
  return response.targets || [];
}

async function transferFile(record, tabId, target) {
  if (record.size > MAX_USE_BYTES) {
    throw new Error('Use is limited to 256 MB per file in this MVP to avoid browser memory crashes.');
  }
  const transferId = crypto.randomUUID();
  const meta = { name: record.name, type: record.type || 'application/octet-stream', size: record.size, lastModified: record.lastModified || Date.now() };
  const begin = await sendToPage(tabId, { type: 'BOXIT_USE_BEGIN_V3', transferId, file: meta, target: target?.token || null });
  if (!begin?.ok) throw new Error(begin?.error || 'Could not start the file transfer.');
  try {
    for (let offset = 0; offset < record.size; offset += CHUNK_BYTES) {
      const slice = record.blob.slice(offset, offset + CHUNK_BYTES);
      const bytes = [...new Uint8Array(await slice.arrayBuffer())];
      const response = await sendToPage(tabId, { type: 'BOXIT_USE_CHUNK_V3', transferId, offset, bytes });
      if (!response?.ok) throw new Error(response?.error || 'The file transfer failed.');
      const percent = record.size ? Math.min(99, Math.round((response.received / record.size) * 100)) : 99;
      showStatus(`Transferring ${record.name}… ${percent}%`, 'neutral');
    }
    const committed = await sendToPage(tabId, { type: 'BOXIT_USE_COMMIT_V3', transferId });
    if (!committed?.ok) throw new Error(committed?.error || 'The page rejected this file.');
    return committed.target || null;
  } catch (error) {
    sendToPage(tabId, { type: 'BOXIT_USE_ABORT_V3', transferId }).catch(() => {});
    throw error;
  }
}

async function offerOneShotCleanup(box, record, targetName) {
  showStatus(`Placed ${record.name} in ${targetName}. Verify the site accepted it before cleaning up this one-shot box.`, 'success', {
    label: 'Delete one-shot box',
    onClick: async event => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Deleting…';
      const response = await chrome.runtime.sendMessage({ type: 'BOXIT_CONFIRM_ONE_SHOT_DELETE', boxId: box.id }).catch(() => null);
      if (response?.deleted) {
        showStatus(`Deleted ${response.boxName}.`, 'success');
        setTimeout(() => window.location.reload(), 350);
      } else {
        button.disabled = false;
        button.textContent = 'Delete one-shot box';
        showStatus(response?.error || 'BoxIt could not delete that one-shot box.', 'error');
      }
    }
  });
}

async function useRecord(record, button, target = null, knownTab = null) {
  button.disabled = true;
  button.textContent = target ? 'Using…' : 'Finding…';
  try {
    const tab = knownTab || await activeTab();
    let selected = target;
    if (!selected) {
      showStatus(`Finding upload controls for ${record.name}…`, 'neutral');
      const targets = await discoverTargets(record, tab.id);
      if (!targets.length) throw new Error('No file upload control was found on this page.');
      if (targets.length > 1) {
        pendingTarget = { record, button, tab, targets };
        targetFileName.textContent = record.name;
        targetList.replaceChildren();
        for (const candidate of targets) {
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'target-option';
          option.dataset.compatible = String(candidate.compatible !== false);
          const copy = document.createElement('span');
          copy.className = 'target-option-copy';
          const label = document.createElement('span');
          label.className = 'target-option-label';
          label.textContent = candidate.label || 'File upload';
          const detail = document.createElement('span');
          detail.className = 'target-option-detail';
          detail.textContent = `${candidate.detail || 'Upload control'}${candidate.compatible === false ? ' · May not match this file type' : ''}`;
          const state = document.createElement('span');
          state.className = 'target-option-state';
          state.textContent = candidate.compatible === false ? 'Check type' : 'Use here';
          copy.append(label, detail);
          option.append(copy, state);
          option.addEventListener('click', async () => {
            const pending = pendingTarget;
            pendingTarget = null;
            targetDialog.close();
            targetList.replaceChildren();
            if (!pending) return;
            await useRecord(pending.record, pending.button, candidate, pending.tab);
          });
          targetList.append(option);
        }
        button.disabled = false;
        button.textContent = 'Use';
        targetDialog.showModal();
        requestAnimationFrame(() => targetList.querySelector('.target-option')?.focus());
        return;
      }
      selected = targets[0];
    }
    showStatus(`Transferring ${record.name}…`, 'neutral');
    const usedTarget = await transferFile(record, tab.id, selected);
    const targetName = usedTarget?.label || selected?.label || 'the selected upload';
    const box = await getBox(record.boxId);
    if (box?.lifecycle?.deleteAfterUse) await offerOneShotCleanup(box, record, targetName);
    else showStatus(`Placed ${record.name} in ${targetName}.`, 'success');
    button.textContent = 'Used';
    setTimeout(() => {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = 'Use';
      }
    }, 1200);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Use';
    showStatus(error?.message || 'BoxIt could not use this file on the page.', 'error');
  }
}

document.addEventListener('click', async event => {
  const button = event.target.closest('.use-file');
  if (!button || !boxesEl.contains(button)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const row = button.closest('.file-row');
  let fileId = row?.dataset.safeFileId;
  if (!fileId) {
    await hydrateMappings();
    fileId = row?.dataset.safeFileId;
  }
  if (!fileId) return showStatus('BoxIt could not identify that file. Reopen the popup and try again.', 'error');
  const record = await getFile(fileId);
  if (!record) return showStatus('That file is no longer available in BoxIt.', 'error');
  await useRecord(record, button);
}, true);

document.addEventListener('change', async event => {
  const input = event.target.closest('.file-input');
  if (!input || !boxesEl.contains(input)) return;
  event.stopImmediatePropagation();
  const files = input.files;
  if (!files?.length) return;
  const card = input.closest('.box-card');
  let boxId = card?.dataset.safeBoxId;
  if (!boxId) {
    await hydrateMappings();
    boxId = card?.dataset.safeBoxId;
  }
  if (!boxId) return showStatus('BoxIt could not identify that box.', 'error');
  try {
    await addFiles(boxId, files);
    showStatus(`Added ${files.length} file${files.length === 1 ? '' : 's'}.`, 'success');
    setTimeout(() => window.location.reload(), 180);
  } catch (error) {
    showStatus(error?.message || 'BoxIt could not import those files.', 'error');
  }
}, true);

cancelTargetButton?.addEventListener('click', () => { pendingTarget = null; }, true);
targetDialog?.addEventListener('close', () => {
  if (pendingTarget?.button?.isConnected) {
    pendingTarget.button.disabled = false;
    pendingTarget.button.textContent = 'Use';
  }
  pendingTarget = null;
}, true);

const observer = new MutationObserver(() => {
  hydrateMappings();
  scheduleObserverNudge();
});
observer.observe(boxesEl, { childList: true, subtree: true });
await hydrateMappings();
scheduleObserverNudge();