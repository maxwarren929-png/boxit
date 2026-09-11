import { addBlob, createBox, findBoxByName, getBox } from './db.js';

const CAPTURE_BOX_KEY = 'boxitCaptureBoxId';
const LAST_CAPTURE_KEY = 'boxitLastCapture';
const MAX_REMOTE_CAPTURE_BYTES = 100 * 1024 * 1024;

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'boxit-save-image',
      title: 'Save image to BoxIt',
      contexts: ['image']
    });
    chrome.contextMenus.create({
      id: 'boxit-save-link',
      title: 'Save linked file to BoxIt',
      contexts: ['link']
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
});

async function preferredCaptureBox(explicitBoxId = null) {
  if (explicitBoxId) {
    const explicit = await getBox(explicitBoxId);
    if (explicit) return explicit;
  }

  const stored = await chrome.storage.local.get(CAPTURE_BOX_KEY);
  if (stored[CAPTURE_BOX_KEY]) {
    const preferred = await getBox(stored[CAPTURE_BOX_KEY]);
    if (preferred) return preferred;
  }

  let box = await findBoxByName('Captured');
  if (!box) box = await createBox('Captured');
  await chrome.storage.local.set({ [CAPTURE_BOX_KEY]: box.id });
  return box;
}

function extensionForType(type) {
  const normalized = String(type || '').split(';')[0].trim().toLowerCase();
  const known = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'application/json': 'json',
    'text/csv': 'csv',
    'application/zip': 'zip'
  };
  return known[normalized] || '';
}

function contentDispositionName(header) {
  if (!header) return '';
  const utf = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf?.[1]) {
    try {
      return decodeURIComponent(utf[1].replace(/^['"]|['"]$/g, ''));
    } catch {
      return utf[1];
    }
  }
  const regular = header.match(/filename\s*=\s*["']?([^;"']+)/i);
  return regular?.[1]?.trim() || '';
}

function nameFromUrl(url, type, headers) {
  const fromHeader = contentDispositionName(headers?.get?.('content-disposition'));
  if (fromHeader) return fromHeader;

  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean).pop();
    if (segment) {
      const decoded = decodeURIComponent(segment);
      if (/\.[a-z0-9]{1,8}$/i.test(decoded)) return decoded;
      const extension = extensionForType(type);
      return extension ? `${decoded}.${extension}` : decoded;
    }
  } catch {
    // Fall through to generated name.
  }

  const extension = extensionForType(type);
  const suffix = extension ? `.${extension}` : '';
  return `capture-${new Date().toISOString().replace(/[:.]/g, '-')}${suffix}`;
}

function isMissingReceiver(error) {
  const message = String(error?.message || error || '');
  return message.includes('Receiving end does not exist') || message.includes('Could not establish connection');
}

async function sendPageMessage(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    if (response !== undefined) return response;
  } catch (error) {
    if (!isMissingReceiver(error)) throw error;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });

  const response = await chrome.tabs.sendMessage(tabId, message);
  if (response === undefined) throw new Error('BoxIt could not connect to this page.');
  return response;
}

async function fetchFromPage(tabId, url) {
  const response = await sendPageMessage(tabId, {
    type: 'BOXIT_FETCH_PAGE_RESOURCE',
    url
  });
  if (!response?.ok || !response.resource) {
    throw new Error(response?.error || 'The page could not provide this resource.');
  }

  const resource = response.resource;
  return {
    blob: new Blob([new Uint8Array(resource.bytes)], { type: resource.type || 'application/octet-stream' }),
    url: resource.url || url,
    headers: null
  };
}

async function fetchRemoteResource(url, pageTabId = null) {
  let directError = null;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not fetch this file (${response.status}).`);

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_REMOTE_CAPTURE_BYTES) {
      throw new Error('This file is larger than BoxIt can capture right now.');
    }

    const blob = await response.blob();
    if (blob.size > MAX_REMOTE_CAPTURE_BYTES) {
      throw new Error('This file is larger than BoxIt can capture right now.');
    }

    return {
      blob,
      url: response.url || url,
      headers: response.headers
    };
  } catch (error) {
    directError = error;
  }

  if (pageTabId) {
    try {
      return await fetchFromPage(pageTabId, url);
    } catch {
      // Keep the direct fetch error because it normally contains the clearer cause.
    }
  }

  throw directError || new Error('BoxIt could not fetch this file.');
}

async function publishCapture(record, box) {
  const event = {
    fileId: record.id,
    fileName: record.name,
    boxId: box.id,
    boxName: box.name,
    capturedAt: Date.now()
  };

  await chrome.storage.local.set({ [LAST_CAPTURE_KEY]: event });
  await chrome.action.setBadgeText({ text: '1' });

  try {
    await chrome.runtime.sendMessage({ type: 'BOXIT_CAPTURE_SAVED', capture: event });
  } catch {
    // The popup is normally closed during context-menu captures.
  }

  return event;
}

async function saveRemoteUrl(url, source = 'web', explicitBoxId = null, pageTabId = null) {
  if (!url) throw new Error('No capture URL was provided.');

  const resource = await fetchRemoteResource(url, pageTabId);
  const box = await preferredCaptureBox(explicitBoxId);
  const name = nameFromUrl(resource.url || url, resource.blob.type, resource.headers);
  const record = await addBlob(box.id, resource.blob, name, { source });
  const capture = await publishCapture(record, box);
  return { record, box, capture };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'boxit-save-image') {
      await saveRemoteUrl(info.srcUrl, 'context-image', null, tab?.id || null);
    } else if (info.menuItemId === 'boxit-save-link') {
      await saveRemoteUrl(info.linkUrl, 'context-link', null, tab?.id || null);
    }
  } catch (error) {
    const message = error?.message || 'BoxIt could not save that item.';
    await chrome.storage.local.set({
      [LAST_CAPTURE_KEY]: {
        error: message,
        capturedAt: Date.now()
      }
    });
    await chrome.action.setBadgeText({ text: '!' });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'BOXIT_CAPTURE_REMOTE_URL') {
    saveRemoteUrl(message.url, message.source || 'web-drop', message.boxId)
      .then(({ capture }) => sendResponse({ ok: true, capture }))
      .catch(error => sendResponse({ ok: false, error: error?.message || 'BoxIt could not capture that URL.' }));
    return true;
  }

  if (message?.type === 'BOXIT_CLEAR_CAPTURE_BADGE') {
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ ok: true });
  }
});
