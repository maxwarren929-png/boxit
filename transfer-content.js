(() => {
  if (globalThis.__boxitTransferV3Installed) return;
  globalThis.__boxitTransferV3Installed = true;

  const USE_SESSIONS = new Map();
  const RESOURCE_SESSIONS = new Map();
  const SESSION_TTL_MS = 5 * 60 * 1000;
  const MAX_PAGE_RESOURCE_BYTES = 25 * 1024 * 1024;

  function cleanText(value, limit = 80) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
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
    const visited = new Set();
    function scan(root) {
      if (!root || visited.has(root) || !root.querySelectorAll) return;
      visited.add(root);
      for (const input of root.querySelectorAll('input[type="file"]')) {
        if (!input.disabled) inputs.push(input);
      }
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) scan(element.shadowRoot);
      }
      for (const frame of root.querySelectorAll('iframe')) {
        try {
          if (frame.contentDocument) scan(frame.contentDocument);
        } catch {}
      }
    }
    scan(document);
    return [...new Set(inputs)];
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
    const enclosing = input.closest('label');
    if (enclosing) parts.push(enclosing.textContent);
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
      for (const candidate of current.querySelectorAll('button, [role="button"], label, [aria-label]')) {
        const text = cleanText(candidate.getAttribute('aria-label') || candidate.textContent);
        if (text && text.length <= 80) return text;
      }
      const own = cleanText(current.textContent);
      if (own && own.length <= 80) return own;
    }
    return '';
  }

  function matchesAccept(file, accept) {
    if (!accept) return true;
    const name = String(file?.name || '').toLowerCase();
    const type = String(file?.type || '').toLowerCase();
    const rules = accept.split(',').map(rule => rule.trim().toLowerCase()).filter(Boolean);
    return !rules.length || rules.some(rule => {
      if (rule.startsWith('.')) return name.endsWith(rule);
      if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
      return type === rule;
    });
  }

  function presentationElement(input) {
    if (isVisible(input)) return input;
    if (input.labels?.length) {
      const label = [...input.labels].find(isVisible);
      if (label) return label;
    }
    let current = input.parentElement;
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      if (isVisible(current)) return current;
    }
    return null;
  }

  function baseSignature(input, label) {
    const form = input.form;
    const formHint = form ? `${form.id || ''}|${form.getAttribute('action') || ''}` : '';
    return [input.id || '', input.name || '', input.getAttribute('accept') || '', input.multiple ? 'm' : 's', label || '', formHint].join('|');
  }

  function scanTargets(file = {}) {
    const counts = new Map();
    const targets = [];
    for (const input of collectFileInputs()) {
      const accept = input.getAttribute('accept') || '';
      const label = labelledText(input) || nearbyText(input) || 'File upload';
      const signature = baseSignature(input, label);
      const ordinal = counts.get(signature) || 0;
      counts.set(signature, ordinal + 1);
      const visible = isVisible(input);
      const presentation = presentationElement(input);
      const compatible = matchesAccept(file, accept);
      let score = compatible ? 40 : 0;
      if (visible) score += 35;
      if (label !== 'File upload') score += 20;
      if (presentation && presentation !== input) score += 10;
      if (accept) score += 5;
      const details = [];
      if (accept) details.push(accept);
      details.push(visible ? 'Visible input' : 'Custom upload control');
      if (input.multiple) details.push('Multiple files');
      targets.push({ input, token: { signature, ordinal }, label, accept, multiple: Boolean(input.multiple), visible, compatible, score, detail: details.join(' · ') });
    }
    return targets.sort((a, b) => b.score - a.score);
  }

  function publicTarget(target) {
    return { token: target.token, label: target.label, accept: target.accept, multiple: target.multiple, visible: target.visible, compatible: target.compatible, score: target.score, detail: target.detail };
  }

  function resolveTarget(token, file) {
    const targets = scanTargets(file);
    if (!targets.length) return null;
    if (!token) return targets[0];
    const exact = targets.find(target => target.token.signature === token.signature && target.token.ordinal === Number(token.ordinal || 0));
    if (exact) return exact;
    return targets.find(target => target.token.signature === token.signature) || targets.find(target => target.compatible) || targets[0];
  }

  function flashTarget(input) {
    const element = presentationElement(input);
    if (!element) return;
    try { element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch {}
    const previous = [element.style.outline, element.style.outlineOffset, element.style.boxShadow];
    element.style.outline = '2px solid #78a7ff';
    element.style.outlineOffset = '3px';
    element.style.boxShadow = '0 0 0 5px rgba(120, 167, 255, 0.15)';
    setTimeout(() => {
      [element.style.outline, element.style.outlineOffset, element.style.boxShadow] = previous;
    }, 1600);
  }

  async function installFile(target, blob, meta) {
    const input = target?.input;
    if (!input?.isConnected || input.disabled) throw new Error('That upload target is no longer available.');
    const view = input.ownerDocument?.defaultView || window;
    const FileCtor = view.File || File;
    const DataTransferCtor = view.DataTransfer || DataTransfer;
    const EventCtor = view.Event || Event;
    const file = new FileCtor([blob], meta.name, { type: meta.type || 'application/octet-stream', lastModified: meta.lastModified || Date.now() });
    const transfer = new DataTransferCtor();
    transfer.items.add(file);
    const descriptor = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'files');
    if (descriptor?.set) descriptor.set.call(input, transfer.files);
    else input.files = transfer.files;
    input.dispatchEvent(new EventCtor('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new EventCtor('change', { bubbles: true, composed: true }));
    await new Promise(resolve => setTimeout(resolve, 60));
    const installed = input.files?.[0];
    if (!installed || installed.name !== meta.name || installed.size !== meta.size) throw new Error('The page cleared the selected file immediately.');
    flashTarget(input);
  }

  function cleanupSessions() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of USE_SESSIONS) if (session.touchedAt < cutoff) USE_SESSIONS.delete(id);
    for (const [id, session] of RESOURCE_SESSIONS) if (session.touchedAt < cutoff) RESOURCE_SESSIONS.delete(id);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    cleanupSessions();
    if (message?.type === 'BOXIT_GET_TARGETS_V3') {
      sendResponse({ ok: true, targets: scanTargets(message.file || {}).map(publicTarget) });
      return;
    }
    if (message?.type === 'BOXIT_USE_BEGIN_V3') {
      const id = String(message.transferId || '');
      if (!id) return sendResponse({ ok: false, error: 'Missing transfer id.' });
      USE_SESSIONS.set(id, { meta: message.file || {}, target: message.target || null, chunks: [], received: 0, touchedAt: Date.now() });
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'BOXIT_USE_CHUNK_V3') {
      const session = USE_SESSIONS.get(String(message.transferId || ''));
      if (!session) return sendResponse({ ok: false, error: 'This file transfer expired.' });
      const offset = Number(message.offset || 0);
      if (offset !== session.received) return sendResponse({ ok: false, error: 'File transfer arrived out of order.' });
      const bytes = new Uint8Array(message.bytes || []);
      session.chunks.push(bytes);
      session.received += bytes.byteLength;
      session.touchedAt = Date.now();
      sendResponse({ ok: true, received: session.received });
      return;
    }
    if (message?.type === 'BOXIT_USE_ABORT_V3') {
      USE_SESSIONS.delete(String(message.transferId || ''));
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'BOXIT_USE_COMMIT_V3') {
      const id = String(message.transferId || '');
      const session = USE_SESSIONS.get(id);
      if (!session) return sendResponse({ ok: false, error: 'This file transfer expired.' });
      (async () => {
        try {
          if (session.received !== Number(session.meta.size || 0)) throw new Error('The file transfer was incomplete.');
          const target = resolveTarget(session.target, session.meta);
          if (!target) throw new Error('No file upload target was found on this page.');
          const blob = new Blob(session.chunks, { type: session.meta.type || 'application/octet-stream' });
          await installFile(target, blob, session.meta);
          sendResponse({ ok: true, target: publicTarget(target) });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || 'BoxIt could not use this file.' });
        } finally {
          USE_SESSIONS.delete(id);
        }
      })();
      return true;
    }
    if (message?.type === 'BOXIT_RESOURCE_PREPARE_V3') {
      (async () => {
        try {
          const response = await fetch(message.url);
          if (!response.ok) throw new Error(`Could not read this page resource (${response.status}).`);
          const blob = await response.blob();
          if (blob.size > MAX_PAGE_RESOURCE_BYTES) throw new Error('This page resource is too large for the capture fallback.');
          const id = crypto.randomUUID();
          RESOURCE_SESSIONS.set(id, { blob, url: response.url || message.url, touchedAt: Date.now() });
          sendResponse({ ok: true, transferId: id, size: blob.size, type: blob.type || response.headers.get('content-type') || 'application/octet-stream', url: response.url || message.url });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || 'BoxIt could not read this page resource.' });
        }
      })();
      return true;
    }
    if (message?.type === 'BOXIT_RESOURCE_READ_V3') {
      const session = RESOURCE_SESSIONS.get(String(message.transferId || ''));
      if (!session) return sendResponse({ ok: false, error: 'This page-resource transfer expired.' });
      (async () => {
        try {
          const offset = Math.max(0, Number(message.offset || 0));
          const length = Math.max(1, Math.min(512 * 1024, Number(message.length || 256 * 1024)));
          const buffer = await session.blob.slice(offset, offset + length).arrayBuffer();
          session.touchedAt = Date.now();
          sendResponse({ ok: true, bytes: [...new Uint8Array(buffer)] });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || 'BoxIt could not read this resource chunk.' });
        }
      })();
      return true;
    }
    if (message?.type === 'BOXIT_RESOURCE_RELEASE_V3') {
      RESOURCE_SESSIONS.delete(String(message.transferId || ''));
      sendResponse({ ok: true });
    }
  });
})();