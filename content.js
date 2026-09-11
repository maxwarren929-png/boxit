const targetIds = new WeakMap();
const targetsById = new Map();
let nextTargetId = 1;

function cleanText(value, limit = 80) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function isVisible(element) {
  if (!element?.isConnected) return false;
  const view = element.ownerDocument?.defaultView || window;
  const style = view.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  return element.getClientRects().length > 0;
}

function collectFileInputs() {
  const inputs = [];
  const visitedRoots = new Set();

  function scan(root) {
    if (!root || visitedRoots.has(root) || !root.querySelectorAll) return;
    visitedRoots.add(root);

    for (const input of root.querySelectorAll('input[type="file"]')) {
      if (!input.disabled) inputs.push(input);
    }

    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) scan(element.shadowRoot);
    }

    for (const frame of root.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) scan(frame.contentDocument);
      } catch {
        // Cross-origin frames cannot be inspected from this content script.
      }
    }
  }

  scan(document);
  return [...new Set(inputs)];
}

function getTargetId(input) {
  let id = targetIds.get(input);
  if (!id) {
    id = `boxit-target-${nextTargetId++}`;
    targetIds.set(input, id);
  }
  targetsById.set(id, input);
  return id;
}

function labelledText(input) {
  const parts = [];
  const doc = input.ownerDocument;

  if (input.getAttribute('aria-label')) parts.push(input.getAttribute('aria-label'));

  const labelledBy = input.getAttribute('aria-labelledby');
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const node = doc.getElementById(id);
      if (node) parts.push(node.textContent);
    }
  }

  if (input.labels?.length) {
    for (const label of input.labels) parts.push(label.textContent);
  }

  const enclosingLabel = input.closest('label');
  if (enclosingLabel) parts.push(enclosingLabel.textContent);

  if (input.name) parts.push(input.name.replace(/[_-]+/g, ' '));
  if (input.id) parts.push(input.id.replace(/[_-]+/g, ' '));

  for (const part of parts) {
    const text = cleanText(part);
    if (text) return text;
  }

  return '';
}

function nearbyText(input) {
  let current = input.parentElement;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
    const candidates = current.querySelectorAll('button, [role="button"], label, [aria-label]');
    for (const candidate of candidates) {
      const text = cleanText(candidate.getAttribute('aria-label') || candidate.textContent);
      if (text && text.length <= 80) return text;
    }

    const ownText = cleanText(current.textContent);
    if (ownText && ownText.length <= 80) return ownText;
  }
  return '';
}

function matchesAccept(file, accept) {
  if (!accept) return true;
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  const rules = accept.split(',').map(rule => rule.trim().toLowerCase()).filter(Boolean);
  if (!rules.length) return true;

  return rules.some(rule => {
    if (rule.startsWith('.')) return name.endsWith(rule);
    if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

function presentationElement(input) {
  if (isVisible(input)) return input;

  if (input.labels?.length) {
    const visibleLabel = [...input.labels].find(isVisible);
    if (visibleLabel) return visibleLabel;
  }

  let current = input.parentElement;
  for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
    if (isVisible(current)) return current;
  }

  return null;
}

function describeTarget(input, file) {
  const accept = input.getAttribute('accept') || '';
  const label = labelledText(input) || nearbyText(input) || 'File upload';
  const visible = isVisible(input);
  const presentation = presentationElement(input);
  const compatible = matchesAccept(file, accept);

  let score = compatible ? 40 : 0;
  if (visible) score += 35;
  if (label !== 'File upload') score += 20;
  if (presentation && presentation !== input) score += 10;
  if (accept) score += 5;

  return {
    id: getTargetId(input),
    label,
    accept,
    multiple: Boolean(input.multiple),
    visible,
    compatible,
    score
  };
}

function scanTargets(file = {}) {
  targetsById.clear();
  return collectFileInputs()
    .map(input => describeTarget(input, file))
    .sort((a, b) => b.score - a.score);
}

function targetDetail(target) {
  const details = [];
  if (target.accept) details.push(target.accept);
  details.push(target.visible ? 'Visible input' : 'Custom upload control');
  if (target.multiple) details.push('Multiple files');
  return details.join(' · ');
}

function flashTarget(input) {
  const element = presentationElement(input);
  if (!element) return;

  try {
    element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  } catch {
    // Some elements do not support smooth scrolling in every context.
  }

  const previousOutline = element.style.outline;
  const previousOutlineOffset = element.style.outlineOffset;
  const previousBoxShadow = element.style.boxShadow;
  element.style.outline = '2px solid #78a7ff';
  element.style.outlineOffset = '3px';
  element.style.boxShadow = '0 0 0 5px rgba(120, 167, 255, 0.15)';

  setTimeout(() => {
    element.style.outline = previousOutline;
    element.style.outlineOffset = previousOutlineOffset;
    element.style.boxShadow = previousBoxShadow;
  }, 1600);
}

function installFile(input, payload) {
  if (!input?.isConnected || input.disabled) {
    throw new Error('That upload target is no longer available.');
  }

  const view = input.ownerDocument?.defaultView || window;
  const FileCtor = view.File || File;
  const DataTransferCtor = view.DataTransfer || DataTransfer;
  const EventCtor = view.Event || Event;
  const file = new FileCtor(
    [new Uint8Array(payload.bytes)],
    payload.name,
    { type: payload.type || 'application/octet-stream', lastModified: payload.lastModified || Date.now() }
  );

  const transfer = new DataTransferCtor();
  transfer.items.add(file);

  const descriptor = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'files');
  if (descriptor?.set) descriptor.set.call(input, transfer.files);
  else input.files = transfer.files;

  input.dispatchEvent(new EventCtor('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new EventCtor('change', { bubbles: true, composed: true }));
  flashTarget(input);
}

async function fetchPageResource(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not read this page resource (${response.status}).`);
  const blob = await response.blob();
  if (blob.size > 25 * 1024 * 1024) {
    throw new Error('This page resource is too large for the capture fallback.');
  }
  return {
    bytes: [...new Uint8Array(await blob.arrayBuffer())],
    type: blob.type || response.headers.get('content-type') || 'application/octet-stream',
    url: response.url || url
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'BOXIT_GET_TARGETS') {
    const targets = scanTargets(message.file || {});
    sendResponse({
      ok: true,
      targets: targets.map(target => ({ ...target, detail: targetDetail(target) }))
    });
    return;
  }

  if (message?.type === 'BOXIT_FETCH_PAGE_RESOURCE') {
    fetchPageResource(message.url)
      .then(resource => sendResponse({ ok: true, resource }))
      .catch(error => sendResponse({ ok: false, error: error?.message || 'BoxIt could not read this page resource.' }));
    return true;
  }

  if (message?.type !== 'BOXIT_USE_FILE_V2') return;

  try {
    const targets = scanTargets(message.file || {});
    let input = message.targetId ? targetsById.get(message.targetId) : null;

    if (!input && !message.targetId && targets.length) {
      input = targetsById.get(targets[0].id);
    }

    if (!input) {
      sendResponse({ ok: false, error: 'No file upload target was found on this page.' });
      return;
    }

    const target = describeTarget(input, message.file || {});
    installFile(input, message.file);
    sendResponse({
      ok: true,
      target: {
        id: target.id,
        label: target.label,
        detail: targetDetail(target)
      }
    });
  } catch (error) {
    sendResponse({ ok: false, error: error?.message || 'BoxIt could not use this file.' });
  }
});
