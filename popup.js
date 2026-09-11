import { listBoxes, createBox, deleteBox, addFiles, listFiles, getFile, deleteFile } from './db.js';

const boxesEl = document.querySelector('#boxes');
const emptyEl = document.querySelector('#empty');
const boxTemplate = document.querySelector('#box-template');
const fileTemplate = document.querySelector('#file-template');
const fileEmptyTemplate = document.querySelector('#file-empty-template');
const newBoxDialog = document.querySelector('#new-box-dialog');
const newBoxForm = document.querySelector('#new-box-form');
const boxNameInput = document.querySelector('#box-name-input');
const cancelNewBoxButton = document.querySelector('#cancel-new-box');
const targetDialog = document.querySelector('#target-dialog');
const targetList = document.querySelector('#target-list');
const targetFileName = document.querySelector('#target-file-name');
const cancelTargetButton = document.querySelector('#cancel-target');
const useStatus = document.querySelector('#use-status');
const useStatusText = document.querySelector('#use-status-text');

let statusTimer = null;
let pendingTargetChoice = null;

for (const button of [document.querySelector('#new-box'), document.querySelector('#empty-new-box')]) {
  button.addEventListener('click', openNewBoxDialog);
}

cancelNewBoxButton.addEventListener('click', () => newBoxDialog.close());
cancelTargetButton.addEventListener('click', closeTargetDialog);

for (const dialog of [newBoxDialog, targetDialog]) {
  dialog.addEventListener('click', event => {
    if (event.target === dialog) {
      if (dialog === targetDialog) closeTargetDialog();
      else dialog.close();
    }
  });
}

newBoxForm.addEventListener('submit', async event => {
  event.preventDefault();
  const name = boxNameInput.value.trim();
  if (!name) {
    boxNameInput.focus();
    return;
  }

  await createBox(name);
  newBoxDialog.close();
  newBoxForm.reset();
  await render();
});

function openNewBoxDialog() {
  newBoxForm.reset();
  newBoxDialog.showModal();
  requestAnimationFrame(() => boxNameInput.focus());
}

function closeTargetDialog() {
  targetDialog.close();
  targetList.replaceChildren();
  pendingTargetChoice = null;
}

function showStatus(message, tone = 'neutral', timeout = 5000) {
  clearTimeout(statusTimer);
  useStatusText.textContent = message;
  useStatus.dataset.tone = tone;
  useStatus.classList.remove('hidden');

  if (timeout > 0) {
    statusTimer = setTimeout(() => useStatus.classList.add('hidden'), timeout);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatFileType(type) {
  if (!type) return 'Unknown type';
  const subtype = type.split('/')[1];
  if (!subtype) return type;
  return subtype.replace('vnd.openxmlformats-officedocument.', '').toUpperCase();
}

function fileMetadata(record) {
  return {
    name: record.name,
    type: record.type,
    lastModified: record.lastModified,
    size: record.size
  };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('BoxIt could not find the current tab.');
  return tab;
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
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch {
    throw new Error('This page does not allow BoxIt to access upload controls.');
  }

  const response = await chrome.tabs.sendMessage(tabId, message);
  if (response === undefined) throw new Error('BoxIt could not connect to this page.');
  return response;
}

async function discoverTargets(record, tabId) {
  const response = await sendToPage(tabId, {
    type: 'BOXIT_GET_TARGETS',
    file: fileMetadata(record)
  });

  if (!response?.ok) throw new Error(response?.error || 'BoxIt could not inspect this page.');
  return response.targets || [];
}

async function filePayload(record) {
  const bytes = [...new Uint8Array(await record.blob.arrayBuffer())];
  return {
    ...fileMetadata(record),
    bytes
  };
}

async function useOnTarget(record, tabId, targetId, originButton) {
  if (originButton) {
    originButton.disabled = true;
    originButton.textContent = 'Using...';
  }

  showStatus(`Adding ${record.name} to the page...`, 'neutral', 0);

  try {
    const response = await sendToPage(tabId, {
      type: 'BOXIT_USE_FILE_V2',
      targetId,
      file: await filePayload(record)
    });

    if (!response?.ok) throw new Error(response?.error || 'The page rejected this file.');

    const targetName = response.target?.label || 'the selected upload';
    showStatus(`Added ${record.name} to ${targetName}.`, 'success');

    if (originButton) {
      originButton.textContent = 'Used';
      setTimeout(() => {
        if (originButton.isConnected) {
          originButton.disabled = false;
          originButton.textContent = 'Use';
        }
      }, 1400);
    }
  } catch (error) {
    if (originButton) {
      originButton.disabled = false;
      originButton.textContent = 'Use';
    }
    showStatus(error?.message || 'BoxIt could not use this file on the page.', 'error', 7000);
  }
}

function openTargetDialog(record, tabId, targets, originButton) {
  pendingTargetChoice = { record, tabId, originButton };
  targetFileName.textContent = record.name;
  targetList.replaceChildren();

  for (const target of targets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'target-option';
    button.dataset.compatible = String(target.compatible !== false);
    button.setAttribute('role', 'listitem');

    const copy = document.createElement('span');
    copy.className = 'target-option-copy';

    const label = document.createElement('span');
    label.className = 'target-option-label';
    label.textContent = target.label || 'File upload';

    const detail = document.createElement('span');
    detail.className = 'target-option-detail';
    const mismatch = target.compatible === false ? ' · May not match this file type' : '';
    detail.textContent = `${target.detail || 'Upload control'}${mismatch}`;

    const state = document.createElement('span');
    state.className = 'target-option-state';
    state.textContent = target.compatible === false ? 'Check type' : 'Use here';

    copy.append(label, detail);
    button.append(copy, state);

    button.addEventListener('click', async () => {
      const pending = pendingTargetChoice;
      if (!pending) return;
      closeTargetDialog();
      await useOnTarget(pending.record, pending.tabId, target.id, pending.originButton);
    });

    targetList.append(button);
  }

  targetDialog.showModal();
  requestAnimationFrame(() => targetList.querySelector('.target-option')?.focus());
}

async function beginUse(record, button) {
  button.disabled = true;
  button.textContent = 'Finding...';
  showStatus(`Finding upload controls for ${record.name}...`, 'neutral', 0);

  try {
    const tab = await activeTab();
    const targets = await discoverTargets(record, tab.id);

    if (!targets.length) {
      throw new Error('No file upload control was found on this page.');
    }

    if (targets.length === 1) {
      await useOnTarget(record, tab.id, targets[0].id, button);
      return;
    }

    button.disabled = false;
    button.textContent = 'Use';
    showStatus(`${targets.length} upload targets found. Choose where to use the file.`, 'neutral');
    openTargetDialog(record, tab.id, targets, button);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Use';
    showStatus(error?.message || 'BoxIt could not inspect this page.', 'error', 7000);
  }
}

async function render() {
  const boxes = await listBoxes();
  boxesEl.replaceChildren();
  emptyEl.classList.toggle('hidden', boxes.length > 0);

  for (const box of boxes) {
    const node = boxTemplate.content.firstElementChild.cloneNode(true);
    const input = node.querySelector('.file-input');
    const drop = node.querySelector('.drop-zone');
    const files = await listFiles(box.id);

    node.querySelector('.box-name').textContent = box.name;
    node.querySelector('.box-meta').textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;

    node.querySelector('.delete-box').addEventListener('click', async () => {
      if (!confirm(`Delete “${box.name}” and everything inside it?`)) return;
      await deleteBox(box.id);
      await render();
    });

    input.addEventListener('change', async () => {
      if (input.files.length) await addFiles(box.id, input.files);
      await render();
    });

    for (const eventName of ['dragenter', 'dragover']) {
      drop.addEventListener(eventName, event => {
        event.preventDefault();
        drop.classList.add('drag');
      });
    }

    for (const eventName of ['dragleave', 'drop']) {
      drop.addEventListener(eventName, event => {
        event.preventDefault();
        drop.classList.remove('drag');
      });
    }

    drop.addEventListener('drop', async event => {
      if (event.dataTransfer.files.length) await addFiles(box.id, event.dataTransfer.files);
      await render();
    });

    const list = node.querySelector('.file-list');
    if (files.length === 0) {
      list.append(fileEmptyTemplate.content.firstElementChild.cloneNode(true));
    } else {
      for (const file of files) list.append(await fileRow(file));
    }

    boxesEl.append(node);
  }
}

async function fileRow(record) {
  const row = fileTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector('.file-name').textContent = record.name;
  row.querySelector('.file-meta').textContent = `${formatBytes(record.size)} · ${formatFileType(record.type)}`;

  row.querySelector('.delete-file').addEventListener('click', async () => {
    await deleteFile(record.id);
    await render();
  });

  row.querySelector('.download-file').addEventListener('click', async () => {
    const stored = await getFile(record.id);
    const url = URL.createObjectURL(stored.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = stored.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const useButton = row.querySelector('.use-file');
  useButton.addEventListener('click', async () => {
    const stored = await getFile(record.id);
    if (!stored) {
      showStatus('That file is no longer available in BoxIt.', 'error');
      return;
    }
    await beginUse(stored, useButton);
  });

  return row;
}

render();
