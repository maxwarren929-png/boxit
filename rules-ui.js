import { listBoxes } from './db.js';
import { clearRuleLogs, deleteRule, listRuleLogs, listRules, saveRule, setRuleEnabled } from './rules-store.js';
import { runRuleScan } from './rules-client.js';

const boxesEl = document.querySelector('#boxes');
const statusEl = document.querySelector('#use-status');
const statusText = document.querySelector('#use-status-text');
let editingRule = null;
let scanTimer = null;
let reloading = false;

function injectStyles() {
  if (document.querySelector('link[data-boxit-rules]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'rules.css';
  link.dataset.boxitRules = 'true';
  document.head.append(link);
}

function showStatus(message, tone = 'neutral') {
  statusText.textContent = message;
  statusEl.dataset.tone = tone;
  statusEl.classList.remove('hidden');
}

function buildUi() {
  if (document.querySelector('#rules-open')) return;
  const newBoxButton = document.querySelector('#new-box');
  const button = document.createElement('button');
  button.id = 'rules-open';
  button.type = 'button';
  button.className = 'button button-secondary rules-open';
  button.textContent = 'Rules';
  newBoxButton.before(button);

  const manager = document.createElement('dialog');
  manager.id = 'rules-dialog';
  manager.className = 'dialog rules-dialog';
  manager.innerHTML = `
    <div class="dialog-card rules-card">
      <div class="rules-heading-row">
        <div class="dialog-heading">
          <p class="dialog-kicker">Automation</p>
          <h2>Rules</h2>
          <p>Match new files, then move, rename, expire, dedupe or convert them automatically.</p>
        </div>
        <button id="rules-add" class="button button-primary" type="button">New rule</button>
      </div>
      <div id="rules-list" class="rules-list"></div>
      <div class="rules-log-head">
        <strong>Recent activity</strong>
        <button id="rules-clear-log" class="button button-ghost" type="button">Clear</button>
      </div>
      <div id="rules-log" class="rules-log"></div>
      <div class="dialog-actions"><button id="rules-close" class="button button-secondary" type="button">Close</button></div>
    </div>`;
  document.body.append(manager);

  const editor = document.createElement('dialog');
  editor.id = 'rule-editor-dialog';
  editor.className = 'dialog rules-dialog';
  editor.innerHTML = `
    <form id="rule-editor-form" class="dialog-card rules-editor-card">
      <div class="dialog-heading">
        <p class="dialog-kicker">Rule</p>
        <h2 id="rule-editor-title">New rule</h2>
        <p>Every filled condition must match. Actions run from top to bottom.</p>
      </div>
      <label class="field"><span>Name</span><input id="rule-name" maxlength="80" required placeholder="Web images to Assets"></label>
      <div class="rules-grid two">
        <label class="field"><span>Trigger</span><select id="rule-trigger"><option value="any">Any new file</option><option value="added">Added/imported</option><option value="captured">Captured</option><option value="converted">Converted</option></select></label>
        <label class="field"><span>From box</span><select id="rule-box"><option value="">Any box</option></select></label>
      </div>
      <div class="rules-section">
        <strong>Conditions</strong>
        <div class="rules-grid two">
          <label class="field"><span>File category</span><select id="rule-category"><option value="">Any category</option><option value="image">Image</option><option value="document">Document / PDF</option><option value="audio">Audio</option><option value="video">Video</option><option value="data">Structured data</option><option value="archive">Archive</option><option value="other">Other</option></select></label>
          <label class="field"><span>Extensions</span><input id="rule-extensions" placeholder="png, jpg, webp"></label>
          <label class="field"><span>Name contains</span><input id="rule-name-contains" placeholder="screenshot"></label>
          <label class="field"><span>Website host contains</span><input id="rule-host" placeholder="github.com"></label>
          <label class="field"><span>Minimum size (MB)</span><input id="rule-min-size" type="number" min="0" step="0.1" placeholder="0"></label>
          <label class="field"><span>Maximum size (MB)</span><input id="rule-max-size" type="number" min="0" step="0.1" placeholder="No limit"></label>
        </div>
      </div>
      <div class="rules-section">
        <strong>Actions</strong>
        <label class="field"><span>Move to box</span><select id="rule-move-box"><option value="">Do not move</option></select></label>
        <label class="field"><span>Rename template</span><input id="rule-rename" maxlength="180" placeholder="{base}-{date}.{ext}"></label>
        <p class="rules-help">Tokens: {name}, {base}, {ext}, {date}, {time}, {source}, {host}</p>
        <div class="rules-grid two">
          <label class="field"><span>Expire after</span><div class="rules-inline"><input id="rule-expire-value" type="number" min="0" step="1" placeholder="Never"><select id="rule-expire-unit"><option value="60000">minutes</option><option value="3600000" selected>hours</option><option value="86400000">days</option></select></div></label>
          <label class="field"><span>Exact duplicates</span><select id="rule-duplicate"><option value="keep">Keep normally</option><option value="reject">Reject the new duplicate</option></select></label>
          <label class="field"><span>Auto-convert</span><select id="rule-convert"><option value="">Do not convert</option><option value="webp">Image → WebP</option><option value="png">Image → PNG</option><option value="jpeg">Image → JPEG</option><option value="json">Data → JSON</option><option value="csv">Data → CSV</option><option value="tsv">Data → TSV</option><option value="ndjson">Data → NDJSON</option></select></label>
          <label class="rules-toggle"><input id="rule-stop" type="checkbox"><span><strong>Stop after this rule</strong><small>Later matching rules will not run on this file.</small></span></label>
        </div>
      </div>
      <div class="rules-engine-note">Automatic image conversion runs in the extension worker for common raster images. Structured-data conversion uses BoxIt's shared data converter. Unsupported input/target combinations are skipped and logged.</div>
      <div class="dialog-actions"><button id="rule-cancel" class="button button-secondary" type="button">Cancel</button><button class="button button-primary" type="submit">Save rule</button></div>
    </form>`;
  document.body.append(editor);

  button.addEventListener('click', openManager);
  manager.querySelector('#rules-close').addEventListener('click', () => manager.close());
  manager.querySelector('#rules-add').addEventListener('click', () => openEditor(null));
  manager.querySelector('#rules-clear-log').addEventListener('click', async () => { await clearRuleLogs(); await renderLogs(); });
  manager.addEventListener('click', event => { if (event.target === manager) manager.close(); });
  editor.querySelector('#rule-cancel').addEventListener('click', () => editor.close());
  editor.addEventListener('click', event => { if (event.target === editor) editor.close(); });
  editor.querySelector('#rule-editor-form').addEventListener('submit', saveEditor);
}

async function fillBoxSelects() {
  const boxes = await listBoxes();
  for (const selector of ['#rule-box', '#rule-move-box']) {
    const select = document.querySelector(selector);
    const first = select.firstElementChild.cloneNode(true);
    select.replaceChildren(first);
    for (const box of boxes) {
      const option = document.createElement('option');
      option.value = box.id;
      option.textContent = box.name;
      select.append(option);
    }
  }
}

function conditionSummary(rule, boxes) {
  const bits = [];
  const box = boxes.find(item => item.id === rule.conditions.boxId);
  if (box) bits.push(`in ${box.name}`);
  if (rule.conditions.category) bits.push(rule.conditions.category);
  if (rule.conditions.extensions?.length) bits.push(rule.conditions.extensions.map(ext => `.${ext}`).join('/'));
  if (rule.conditions.nameContains) bits.push(`name has “${rule.conditions.nameContains}”`);
  if (rule.conditions.hostContains) bits.push(rule.conditions.hostContains);
  return bits.length ? bits.join(' · ') : 'all matching files';
}

function actionSummary(rule, boxes) {
  const bits = [];
  const box = boxes.find(item => item.id === rule.actions.moveBoxId);
  if (box) bits.push(`move → ${box.name}`);
  if (rule.actions.renameTemplate) bits.push('rename');
  if (rule.actions.expireAfterMs) bits.push(`expire ${formatDuration(rule.actions.expireAfterMs)}`);
  if (rule.actions.duplicate === 'reject') bits.push('reject duplicates');
  if (rule.actions.convertFormat) bits.push(`convert → ${rule.actions.convertFormat.toUpperCase()}`);
  return bits.join(' · ') || 'no actions';
}

function formatDuration(ms) {
  const hours = ms / 3600000;
  if (hours < 1) return `${Math.round(ms / 60000)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(ms / 86400000)}d`;
}

async function renderManager() {
  const [rules, boxes] = await Promise.all([listRules(), listBoxes()]);
  const list = document.querySelector('#rules-list');
  list.replaceChildren();
  if (!rules.length) {
    const empty = document.createElement('div');
    empty.className = 'rules-empty';
    empty.textContent = 'No rules yet. Add one to make BoxIt react to new files.';
    list.append(empty);
  }
  for (const rule of rules) {
    const row = document.createElement('article');
    row.className = 'rule-row';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = rule.enabled;
    toggle.setAttribute('aria-label', `Enable ${rule.name}`);
    toggle.addEventListener('change', async () => { await setRuleEnabled(rule.id, toggle.checked); await renderManager(); });
    const copy = document.createElement('div');
    copy.className = 'rule-copy';
    const title = document.createElement('strong');
    title.textContent = rule.name;
    const when = document.createElement('span');
    when.textContent = `${rule.trigger === 'any' ? 'Any new file' : rule.trigger} · ${conditionSummary(rule, boxes)}`;
    const actions = document.createElement('small');
    actions.textContent = actionSummary(rule, boxes);
    copy.append(title, when, actions);
    const controls = document.createElement('div');
    controls.className = 'rule-controls';
    const edit = document.createElement('button');
    edit.type = 'button'; edit.className = 'button button-ghost'; edit.textContent = 'Edit';
    edit.addEventListener('click', () => openEditor(rule));
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'button button-ghost button-danger'; remove.textContent = 'Delete';
    remove.addEventListener('click', async () => { if (!confirm(`Delete rule “${rule.name}”?`)) return; await deleteRule(rule.id); await renderManager(); });
    controls.append(edit, remove);
    row.append(toggle, copy, controls);
    list.append(row);
  }
  await renderLogs();
}

async function renderLogs() {
  const logs = await listRuleLogs(12);
  const host = document.querySelector('#rules-log');
  if (!host) return;
  host.replaceChildren();
  if (!logs.length) {
    const empty = document.createElement('div');
    empty.className = 'rules-log-empty'; empty.textContent = 'No rule activity yet.'; host.append(empty); return;
  }
  for (const log of logs) {
    const row = document.createElement('div');
    row.className = 'rules-log-row'; row.dataset.tone = log.tone;
    const main = document.createElement('span');
    main.textContent = `${log.ruleName || 'Rule'} · ${log.fileName || 'file'}`;
    const detail = document.createElement('small');
    detail.textContent = log.message;
    row.append(main, detail);
    host.append(row);
  }
}

async function openManager() {
  await renderManager();
  document.querySelector('#rules-dialog').showModal();
}

function setInput(id, value) { document.querySelector(id).value = value ?? ''; }

async function openEditor(rule) {
  editingRule = rule;
  await fillBoxSelects();
  document.querySelector('#rule-editor-title').textContent = rule ? 'Edit rule' : 'New rule';
  setInput('#rule-name', rule?.name || '');
  setInput('#rule-trigger', rule?.trigger || 'any');
  setInput('#rule-box', rule?.conditions?.boxId || '');
  setInput('#rule-category', rule?.conditions?.category || '');
  setInput('#rule-extensions', rule?.conditions?.extensions?.join(', ') || '');
  setInput('#rule-name-contains', rule?.conditions?.nameContains || '');
  setInput('#rule-host', rule?.conditions?.hostContains || '');
  setInput('#rule-min-size', rule?.conditions?.minBytes ? rule.conditions.minBytes / 1024 / 1024 : '');
  setInput('#rule-max-size', rule?.conditions?.maxBytes ? rule.conditions.maxBytes / 1024 / 1024 : '');
  setInput('#rule-move-box', rule?.actions?.moveBoxId || '');
  setInput('#rule-rename', rule?.actions?.renameTemplate || '');
  const expiry = Number(rule?.actions?.expireAfterMs || 0);
  let unit = 3600000;
  if (expiry && expiry % 86400000 === 0) unit = 86400000;
  else if (expiry && expiry < 3600000) unit = 60000;
  setInput('#rule-expire-unit', String(unit));
  setInput('#rule-expire-value', expiry ? expiry / unit : '');
  setInput('#rule-duplicate', rule?.actions?.duplicate || 'keep');
  setInput('#rule-convert', rule?.actions?.convertFormat || '');
  document.querySelector('#rule-stop').checked = Boolean(rule?.stop);
  document.querySelector('#rule-editor-dialog').showModal();
  requestAnimationFrame(() => document.querySelector('#rule-name').focus());
}

async function saveEditor(event) {
  event.preventDefault();
  const expireValue = Math.max(0, Number(document.querySelector('#rule-expire-value').value) || 0);
  const expireUnit = Number(document.querySelector('#rule-expire-unit').value) || 3600000;
  const rule = {
    ...(editingRule || {}),
    name: document.querySelector('#rule-name').value,
    trigger: document.querySelector('#rule-trigger').value,
    conditions: {
      boxId: document.querySelector('#rule-box').value,
      category: document.querySelector('#rule-category').value,
      extensions: document.querySelector('#rule-extensions').value,
      nameContains: document.querySelector('#rule-name-contains').value,
      hostContains: document.querySelector('#rule-host').value,
      minBytes: Math.max(0, Number(document.querySelector('#rule-min-size').value) || 0) * 1024 * 1024,
      maxBytes: Math.max(0, Number(document.querySelector('#rule-max-size').value) || 0) * 1024 * 1024
    },
    actions: {
      moveBoxId: document.querySelector('#rule-move-box').value,
      renameTemplate: document.querySelector('#rule-rename').value,
      expireAfterMs: expireValue * expireUnit,
      duplicate: document.querySelector('#rule-duplicate').value,
      convertFormat: document.querySelector('#rule-convert').value
    },
    stop: document.querySelector('#rule-stop').checked
  };
  const hasAction = rule.actions.moveBoxId || rule.actions.renameTemplate || rule.actions.expireAfterMs || rule.actions.duplicate === 'reject' || rule.actions.convertFormat;
  if (!hasAction) {
    showStatus('Give the rule at least one action.', 'error');
    return;
  }
  await saveRule(rule);
  editingRule = null;
  document.querySelector('#rule-editor-dialog').close();
  await renderManager();
}

async function scanNow() {
  clearTimeout(scanTimer);
  scanTimer = null;
  let pageUrl = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    pageUrl = tab?.url || '';
  } catch {}
  const result = await runRuleScan({ pageUrl });
  if (!result.ok) return;
  if ((result.changed || result.deleted || result.generated) && !reloading) {
    reloading = true;
    showStatus(`${result.results?.length || 1} rule action${result.results?.length === 1 ? '' : 's'} applied.`, 'success');
    setTimeout(() => window.location.reload(), 180);
  }
}

function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scanNow, 120);
}

injectStyles();
buildUi();
const observer = new MutationObserver(scheduleScan);
observer.observe(boxesEl, { childList: true, subtree: true });
await scanNow();
