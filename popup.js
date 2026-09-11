import {
  listBoxes,
  createBox,
  deleteBox,
  addFiles,
  addBlob,
  listFiles,
  getFile,
  deleteFile
} from './db.js';

const CAPTURE_BOX_KEY = 'boxitCaptureBoxId';
const LAST_CAPTURE_KEY = 'boxitLastCapture';

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

chrome.runtime.onMessage.addListener(message => {
  if (message?.type !== 'BOXIT_CAPTURE_SAVED' || !message.capture) return;
  const capture = message.capture;
  showStatus(`Saved ${capture.fileName} to ${capture.boxName}.`, 'success');
  render();
  chrome.runtime.sendMessage({ type: 'BOXIT_CLEAR_CAPTURE_BADGE' }).catch(() => {});
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

function extensionForType(type) {
  const known = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg'
  };
  return known[String(type || '').toLowerCase()] || 'img';
}

function timestampForName() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]+/gi, '-').slice(0, 48) || 'page';
  } catch {
    return 'page';
  }
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

async function captureBoxId() {
  const stored = await chrome.storage.local.get(CAPTURE_BOX_KEY);
  return stored[CAPTURE_BOX_KEY] || null;
}

async function setCaptureBox(box) {
  await chrome.storage.local.set({ [CAPTURE_BOX_KEY]: box.id });
  showStatus(`Right-click captures will now save to ${box.name}.`, 'success');
  await render();
}

async function pasteImage(box, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Reading...';

  try {
    const items = await navigator.clipboard.read();
    const images = [];

    for (const item of items) {
      const type = item.types.find(candidate => candidate.startsWith('image/'));
      if (!type) continue;
      images.push({ type, blob: await item.getType(type) });
    }

    if (!images.length) throw new Error('There is no image in the clipboard.');

    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const suffix = images.length > 1 ? `-${index + 1}` : '';
      const name = `clipboard-${timestampForName()}${suffix}.${extensionForType(image.type)}`;
      await addBlob(box.id, image.blob, name, { source: 'clipboard' });
    }

    showStatus(`Saved ${images.length === 1 ? 'clipboard image' : `${images.length} clipboard images`} to ${box.name}.`, 'success');
    await render();
  } catch (error) {
    showStatus(error?.message || 'BoxIt could not read an image from the clipboard.', 'error', 7000);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

async function captureScreenshot(box, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Capturing...';

  try {
    const tab = await activeTab();
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const blob = await (await fetch(dataUrl)).blob();
    const name = `screenshot-${safeHost(tab.url)}-${timestampForName()}.png`;
    await addBlob(box.id, blob, name, { source: 'screenshot' });
    showStatus(`Saved a screenshot to ${box.name}.`, 'success');
    await render();
  } catch (error) {
    showStatus(error?.message || 'BoxIt could not capture this tab.', 'error', 7000);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function remoteUrlFromDrop(dataTransfer) {
  const uriList = dataTransfer.getData('text/uri-list');
  if (uriList) {
    const url = uriList.split(/\r?\n/).find(line => line && !line.startsWith('#'));
    if (/^https?:\/\//i.test(url || '')) return url;
  }

  const html = dataTransfer.getData('text/html');
  if (html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const source = parsed.querySelector('img[src]')?.src || parsed.querySelector('a[href]')?.href;
    if (/^https?:\/\//i.test(source || '')) return source;
  }

  const plain = dataTransfer.getData('text/plain').trim();
  if (/^https?:\/\//i.test(plain)) return plain;
  return null;
}

async function captureRemoteDrop(box, url) {
  showStatus(`Saving webpage content to ${box.name}...`, 'neutral', 0);
  const response = await chrome.runtime.sendMessage({
    type: 'BOXIT_CAPTURE_REMOTE_URL',
    boxId: box.id,
    url,
    source: 'web-drop'
  });

  if (!response?.ok) throw new Error(response?.error || 'BoxIt could not save that webpage item.');
  showStatus(`Saved ${response.capture.fileName} to ${box.name}.`, 'success');
  await render();
}

async function render() {
  const [boxes, defaultCaptureBoxId] = await Promise.all([listBoxes(), captureBoxId()]);
  boxesEl.replaceChildren();
  emptyEl.classList.toggle('hidden', boxes.length > 0);

  for (const box of boxes) {
    const node = boxTemplate.content.firstElementChild.cloneNode(true);
    const input = node.querySelector('.file-input');
    const drop = node.querySelector('.drop-zone');
    const files = await listFiles(box.id);
    const isCaptureDefault = defaultCaptureBoxId === box.id;

    node.querySelector('.box-name').textContent = box.name;
    node.querySelector('.box-meta').textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;
    node.querySelector('.capture-default-tag').classList.toggle('hidden', !isCaptureDefault);

    const captureHereButton = node.querySelector('.set-capture-box');
    captureHereButton.dataset.active = String(isCaptureDefault);
    captureHereButton.textContent = isCaptureDefault ? 'Capture default' : 'Capture here';
    captureHereButton.disabled = isCaptureDefault;
    captureHereButton.addEventListener('click', () => setCaptureBox(box));

    node.querySelector('.paste-image').addEventListener('click', event => pasteImage(box, event.currentTarget));
    node.querySelector('.capture-screenshot').addEventListener('click', event => captureScreenshot(box, event.currentTarget));

    node.querySelector('.delete-box').addEventListener('click', async () => {
      if (!confirm(`Delete “${box.name}” and everything inside it?`)) return;
      await deleteBox(box.id);
      if (isCaptureDefault) await chrome.storage.local.remove(CAPTURE_BOX_KEY);
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
      try {
        if (event.dataTransfer.files.length) {
          await addFiles(box.id, event.dataTransfer.files);
          showStatus(`Added ${event.dataTransfer.files.length} file${event.dataTransfer.files.length === 1 ? '' : 's'} to ${box.name}.`, 'success');
          await render();
          return;
        }

        const url = remoteUrlFromDrop(event.dataTransfer);
        if (!url) throw new Error('BoxIt could not find a file or webpage image in that drop.');
        await captureRemoteDrop(box, url);
      } catch (error) {
        showStatus(error?.message || 'BoxIt could not capture that drop.', 'error', 7000);
      }
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

async function showRecentCapture() {
  const stored = await chrome.storage.local.get(LAST_CAPTURE_KEY);
  const capture = stored[LAST_CAPTURE_KEY];
  if (!capture) return;

  const recent = Date.now() - Number(capture.capturedAt || 0) < 30000;
  if (recent) {
    if (capture.error) showStatus(capture.error, 'error', 7000);
    else if (capture.fileName && capture.boxName) showStatus(`Saved ${capture.fileName} to ${capture.boxName}.`, 'success');
  }
  await chrome.storage.local.remove(LAST_CAPTURE_KEY);
}

async function init() {
  await showRecentCapture();
  await render();
  chrome.runtime.sendMessage({ type: 'BOXIT_CLEAR_CAPTURE_BADGE' }).catch(() => {});
}

init();
