import {
  addBlob,
  deleteFile,
  getBox,
  getFile,
  listAllFiles,
  listFiles,
  renameFile,
  setFileHash
} from './db.js';
import { tableConverter } from './conversion-table.js';
import { baseName, extensionOf, outputName } from './conversion-utils.js';
import { appendRuleLog, listRules } from './rules-store.js';
import { moveFile, patchFile } from './rules-db.js';

export const RULES_PROCESSED_VERSION = 1;
export const RULE_FILE_EXPIRY_ALARM = 'boxit-rules-file-expiry';
export const RULE_SCAN_ALARM = 'boxit-rules-scan';
export const RULE_PERIODIC_SCAN_ALARM = 'boxit-rules-periodic-scan';

const MAX_SCAN_BATCH = 100;
const MAX_RULE_DEPTH = 4;
const MAX_DUPLICATE_HASH_BYTES = 64 * 1024 * 1024;
const MAX_AUTO_IMAGE_PIXELS = 40_000_000;
const MAX_AUTO_IMAGE_SIDE = 8192;
const CAPTURE_SOURCES = new Set(['clipboard', 'screenshot', 'context-image', 'context-link', 'web-drop', 'web']);
const DATA_EXTENSIONS = new Set(['json', 'jsonl', 'ndjson', 'csv', 'tsv']);
const DOCUMENT_EXTENSIONS = new Set(['docx', 'txt', 'md', 'markdown', 'html', 'htm', 'pdf']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const AUTO_IMAGE_TARGETS = {
  png: { mime: 'image/png', extension: 'png' },
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  webp: { mime: 'image/webp', extension: 'webp' }
};

let scanPromise = null;

function sourceTrigger(record) {
  const source = String(record?.source || '').toLowerCase();
  if (source.includes('conversion')) return 'converted';
  if (CAPTURE_SOURCES.has(source)) return 'captured';
  return 'added';
}

function categoryOf(record) {
  const type = String(record?.type || '').toLowerCase();
  const extension = extensionOf(record?.name);
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (type.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (DATA_EXTENSIONS.has(extension) || type.includes('json') || type === 'text/csv' || type === 'text/tab-separated-values') return 'data';
  if (DOCUMENT_EXTENSIONS.has(extension) || type.includes('wordprocessingml') || type === 'text/plain' || type === 'text/markdown' || type === 'text/html' || type === 'application/pdf') return 'document';
  if (ARCHIVE_EXTENSIONS.has(extension) || type.includes('zip') || type.includes('compressed') || type.includes('archive')) return 'archive';
  return 'other';
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function matchesRule(rule, record, trigger, context = {}) {
  if (!rule.enabled) return false;
  if (rule.trigger !== 'any' && rule.trigger !== trigger) return false;
  const conditions = rule.conditions || {};
  if (conditions.boxId && conditions.boxId !== record.boxId) return false;
  if (conditions.category && conditions.category !== categoryOf(record)) return false;
  if (conditions.extensions?.length && !conditions.extensions.includes(extensionOf(record.name))) return false;
  if (conditions.nameContains && !String(record.name || '').toLowerCase().includes(conditions.nameContains)) return false;
  const capturePageUrl = CAPTURE_SOURCES.has(String(record.source || '').toLowerCase()) ? context.pageUrl || '' : '';
  const host = hostOf(record.sourceUrl || context.sourceUrl || capturePageUrl || '');
  if (conditions.hostContains && !host.includes(conditions.hostContains)) return false;
  const size = Number(record.size || 0);
  if (conditions.minBytes > 0 && size < conditions.minBytes) return false;
  if (conditions.maxBytes > 0 && size > conditions.maxBytes) return false;
  return true;
}

function templateName(template, record, context = {}) {
  const now = new Date();
  const extension = extensionOf(record.name);
  const tokens = {
    name: record.name,
    base: baseName(record.name),
    ext: extension,
    date: now.toISOString().slice(0, 10),
    time: now.toTimeString().slice(0, 8).replace(/:/g, '-'),
    source: String(record.source || 'file').replace(/[^a-z0-9_-]+/gi, '-'),
    host: hostOf(record.sourceUrl || context.sourceUrl || (CAPTURE_SOURCES.has(String(record.source || '').toLowerCase()) ? context.pageUrl || '' : '')) || 'local'
  };
  let name = String(template || '').replace(/\{(name|base|ext|date|time|source|host)\}/g, (_all, token) => tokens[token]);
  name = name.replace(/[\\/\0]/g, '-').replace(/\s+/g, ' ').trim();
  return name.slice(0, 180) || record.name;
}

async function hashRecord(record) {
  if (record.hash) return record.hash;
  if (!record.blob || Number(record.size || 0) > MAX_DUPLICATE_HASH_BYTES) return null;
  const digest = await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer());
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  await setFileHash(record.id, hash);
  record.hash = hash;
  return hash;
}

async function exactDuplicate(record) {
  if (Number(record.size || 0) > MAX_DUPLICATE_HASH_BYTES) return null;
  const candidates = (await listFiles(record.boxId)).filter(file => file.id !== record.id && Number(file.size || 0) === Number(record.size || 0));
  if (!candidates.length) return null;
  const hash = await hashRecord(record);
  if (!hash) return null;
  for (const candidate of candidates) {
    const candidateHash = await hashRecord(candidate);
    if (candidateHash && candidateHash === hash) return candidate;
  }
  return null;
}

function imageTargetFor(format) {
  return AUTO_IMAGE_TARGETS[format] || null;
}

async function autoConvertImage(record, format) {
  const target = imageTargetFor(format);
  if (!target) return null;
  if (!String(record.type || '').startsWith('image/')) return null;
  if (!globalThis.createImageBitmap || !globalThis.OffscreenCanvas) {
    throw new Error('Automatic image conversion is not available in this browser worker.');
  }
  const bitmap = await createImageBitmap(record.blob);
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    if (!width || !height || width > MAX_AUTO_IMAGE_SIDE || height > MAX_AUTO_IMAGE_SIDE || width * height > MAX_AUTO_IMAGE_PIXELS) {
      throw new Error('This image is too large for automatic rule conversion.');
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: target.mime !== 'image/jpeg' });
    if (!context) throw new Error('BoxIt could not create an automatic image converter.');
    if (target.mime === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: target.mime, quality: target.mime === 'image/png' ? undefined : 0.88 });
    return {
      blob,
      name: outputName(record, target.extension, { forceSuffix: extensionOf(record.name) === target.extension, suffix: 'auto' }),
      summary: `${format.toUpperCase()} ${width}×${height}`
    };
  } finally {
    bitmap.close?.();
  }
}

async function autoConvert(record, format) {
  if (imageTargetFor(format)) return autoConvertImage(record, format);
  if (['json', 'csv', 'tsv', 'ndjson'].includes(format) && tableConverter.matches(record)) {
    return tableConverter.convert(record, { format, firstRowHeaders: true, jsonIndent: 2 });
  }
  return null;
}

async function logRule(rule, record, message, tone = 'success') {
  await appendRuleLog({ ruleId: rule.id, ruleName: rule.name, fileName: record?.name || '', message, tone });
}

function humanDuration(milliseconds) {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

async function applyRule(rule, record, context, depth, trace) {
  const actions = rule.actions || {};
  let changed = false;
  let generated = 0;
  let current = record;
  const notes = [];

  if (actions.duplicate === 'reject') {
    if (Number(current.size || 0) > MAX_DUPLICATE_HASH_BYTES) {
      notes.push('duplicate check skipped above 64 MB');
    } else {
      const duplicate = await exactDuplicate(current);
      if (duplicate) {
        await deleteFile(current.id);
        await logRule(rule, current, `Rejected exact duplicate of ${duplicate.name}.`);
        return { record: null, deleted: true, changed: true, generated, note: 'rejected exact duplicate' };
      }
    }
  }

  if (actions.moveBoxId && actions.moveBoxId !== current.boxId) {
    const targetBox = await getBox(actions.moveBoxId);
    if (!targetBox) throw new Error('Move destination no longer exists.');
    current = await moveFile(current.id, actions.moveBoxId);
    changed = true;
    notes.push(`moved to ${targetBox.name}`);
  }

  if (actions.renameTemplate) {
    const nextName = templateName(actions.renameTemplate, current, context);
    if (nextName !== current.name) {
      current = await renameFile(current.id, nextName);
      changed = true;
      notes.push(`renamed to ${nextName}`);
    }
  }

  if (actions.expireAfterMs > 0) {
    const expiresAt = Date.now() + actions.expireAfterMs;
    current = await patchFile(current.id, { expiresAt });
    await scheduleNextFileExpiry();
    changed = true;
    notes.push(`expires in ${humanDuration(actions.expireAfterMs)}`);
  }

  if (actions.convertFormat && depth < MAX_RULE_DEPTH) {
    const converted = await autoConvert(current, actions.convertFormat);
    if (converted) {
      let saved = await addBlob(current.boxId, converted.blob, converted.name, { source: 'rule-conversion' });
      saved = await patchFile(saved.id, {
        source: 'rule-conversion',
        sourceUrl: current.sourceUrl || context.sourceUrl || context.pageUrl || '',
        parentFileId: current.id,
        ruleTrace: [...trace, rule.id],
        rulesProcessedVersion: 0,
        expiresAt: Number(current.expiresAt || 0) || undefined
      });
      generated += 1;
      changed = true;
      notes.push(`created ${saved.name}`);
      const nested = await processFile(saved.id, { ...context, trigger: 'converted' }, depth + 1);
      generated += Number(nested.generated || 0);
      changed = changed || Boolean(nested.changed);
    } else {
      notes.push(`auto-convert ${actions.convertFormat} not applicable`);
    }
  }

  await logRule(rule, current, notes.length ? notes.join(' · ') : 'Matched with no changes.', notes.length ? 'success' : 'skip');
  return { record: current, deleted: false, changed, generated, note: notes.join(' · ') };
}

async function processFile(fileId, context = {}, depth = 0) {
  let record = await getFile(fileId);
  if (!record) return { processed: false, changed: false, deleted: false, generated: 0, results: [] };
  if (!context.force && Number(record.rulesProcessedVersion || 0) >= RULES_PROCESSED_VERSION) {
    return { processed: false, changed: false, deleted: false, generated: 0, results: [] };
  }
  if (depth > MAX_RULE_DEPTH) {
    await patchFile(record.id, { rulesProcessedVersion: RULES_PROCESSED_VERSION });
    return { processed: true, changed: false, deleted: false, generated: 0, results: [] };
  }

  const contextUrl = record.sourceUrl || context.sourceUrl || (CAPTURE_SOURCES.has(String(record.source || '').toLowerCase()) ? context.pageUrl || '' : '');
  if (!record.sourceUrl && contextUrl) record = await patchFile(record.id, { sourceUrl: contextUrl });
  const trigger = context.trigger || sourceTrigger(record);
  const rules = await listRules();
  const trace = Array.isArray(record.ruleTrace) ? [...record.ruleTrace] : [];
  const results = [];
  let changed = false;
  let generated = 0;
  let deleted = false;

  for (const rule of rules) {
    if (trace.includes(rule.id)) continue;
    if (!matchesRule(rule, record, trigger, context)) continue;
    try {
      const result = await applyRule(rule, record, context, depth, trace);
      results.push({ ruleId: rule.id, ruleName: rule.name, note: result.note, changed: result.changed, deleted: result.deleted });
      changed = changed || result.changed;
      generated += Number(result.generated || 0);
      trace.push(rule.id);
      if (result.deleted) {
        deleted = true;
        break;
      }
      record = result.record || await getFile(fileId);
      if (record) record = await patchFile(record.id, { ruleTrace: trace });
      if (rule.stop) break;
    } catch (error) {
      trace.push(rule.id);
      await logRule(rule, record, error?.message || 'Rule failed.', 'error');
      results.push({ ruleId: rule.id, ruleName: rule.name, note: error?.message || 'Rule failed.', error: true });
      if (record) record = await patchFile(record.id, { ruleTrace: trace });
      if (rule.stop) break;
    }
  }

  if (!deleted) {
    record = await getFile(fileId);
    if (record) await patchFile(fileId, { rulesProcessedVersion: RULES_PROCESSED_VERSION, ruleTrace: trace });
  }
  return { processed: true, changed, deleted, generated, results };
}

export async function scanPendingFiles(context = {}) {
  if (scanPromise) return scanPromise;
  scanPromise = (async () => {
    const files = await listAllFiles();
    const allPending = files.filter(file => Number(file.rulesProcessedVersion || 0) < RULES_PROCESSED_VERSION);
    const pending = allPending.slice(0, MAX_SCAN_BATCH);
    const aggregate = { processed: 0, changed: false, deleted: 0, generated: 0, results: [], remaining: Math.max(0, allPending.length - pending.length) };
    for (const file of pending) {
      const hintMatches = !context.source || context.source === file.source;
      const fileContext = hintMatches ? context : {};
      const result = await processFile(file.id, fileContext, 0);
      if (result.processed) aggregate.processed += 1;
      aggregate.changed = aggregate.changed || result.changed;
      aggregate.deleted += result.deleted ? 1 : 0;
      aggregate.generated += Number(result.generated || 0);
      aggregate.results.push(...result.results);
    }
    return aggregate;
  })();
  try { return await scanPromise; } finally { scanPromise = null; }
}

export async function expireDueFiles(now = Date.now()) {
  const files = await listAllFiles();
  let removed = 0;
  for (const file of files) {
    const expiresAt = Number(file.expiresAt || 0);
    if (expiresAt > 0 && expiresAt <= now) {
      await deleteFile(file.id);
      removed += 1;
    }
  }
  await scheduleNextFileExpiry();
  return removed;
}

export async function scheduleNextFileExpiry() {
  const files = await listAllFiles();
  const next = files.map(file => Number(file.expiresAt || 0)).filter(value => value > Date.now()).sort((a, b) => a - b)[0];
  await chrome.alarms.clear(RULE_FILE_EXPIRY_ALARM);
  if (next) chrome.alarms.create(RULE_FILE_EXPIRY_ALARM, { when: next });
  return next || null;
}
