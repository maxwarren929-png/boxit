const RULES_KEY = 'boxitRulesV1';
const RULE_LOG_KEY = 'boxitRuleLogV1';
const MAX_LOGS = 80;

function cleanText(value, max = 180) {
  return String(value || '').trim().slice(0, max);
}

function normalizeExtensions(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(items.map(item => String(item).trim().toLowerCase().replace(/^\./, '')).filter(Boolean))].slice(0, 20);
}

export function normalizeRule(input = {}) {
  const conditions = input.conditions || {};
  const actions = input.actions || {};
  return {
    id: cleanText(input.id, 80) || crypto.randomUUID(),
    name: cleanText(input.name, 80) || 'Untitled rule',
    enabled: input.enabled !== false,
    trigger: ['any', 'added', 'captured', 'converted'].includes(input.trigger) ? input.trigger : 'any',
    conditions: {
      boxId: cleanText(conditions.boxId, 80),
      category: ['image', 'document', 'audio', 'video', 'data', 'archive', 'other'].includes(conditions.category) ? conditions.category : '',
      extensions: normalizeExtensions(conditions.extensions),
      nameContains: cleanText(conditions.nameContains, 120).toLowerCase(),
      hostContains: cleanText(conditions.hostContains, 120).toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, ''),
      minBytes: Math.max(0, Number(conditions.minBytes) || 0),
      maxBytes: Math.max(0, Number(conditions.maxBytes) || 0)
    },
    actions: {
      moveBoxId: cleanText(actions.moveBoxId, 80),
      renameTemplate: cleanText(actions.renameTemplate, 180),
      expireAfterMs: Math.max(0, Number(actions.expireAfterMs) || 0),
      duplicate: actions.duplicate === 'reject' ? 'reject' : 'keep',
      convertFormat: ['png', 'jpeg', 'webp', 'json', 'csv', 'tsv', 'ndjson'].includes(actions.convertFormat) ? actions.convertFormat : ''
    },
    stop: Boolean(input.stop),
    createdAt: Number(input.createdAt) || Date.now(),
    updatedAt: Number(input.updatedAt) || Date.now()
  };
}

export async function listRules() {
  const stored = await chrome.storage.local.get(RULES_KEY);
  const raw = Array.isArray(stored[RULES_KEY]) ? stored[RULES_KEY] : [];
  return raw.map(normalizeRule).sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveRule(rule) {
  const rules = await listRules();
  const normalized = { ...normalizeRule(rule), updatedAt: Date.now() };
  const index = rules.findIndex(item => item.id === normalized.id);
  if (index >= 0) {
    normalized.createdAt = rules[index].createdAt;
    rules[index] = normalized;
  } else {
    rules.push(normalized);
  }
  await chrome.storage.local.set({ [RULES_KEY]: rules });
  return normalized;
}

export async function deleteRule(ruleId) {
  const rules = await listRules();
  await chrome.storage.local.set({ [RULES_KEY]: rules.filter(rule => rule.id !== ruleId) });
}

export async function setRuleEnabled(ruleId, enabled) {
  const rules = await listRules();
  const rule = rules.find(item => item.id === ruleId);
  if (!rule) return null;
  return saveRule({ ...rule, enabled: Boolean(enabled) });
}

export async function appendRuleLog(entry) {
  const stored = await chrome.storage.local.get(RULE_LOG_KEY);
  const logs = Array.isArray(stored[RULE_LOG_KEY]) ? stored[RULE_LOG_KEY] : [];
  logs.unshift({
    id: crypto.randomUUID(),
    at: Date.now(),
    ruleId: String(entry.ruleId || ''),
    ruleName: cleanText(entry.ruleName, 80),
    fileName: cleanText(entry.fileName, 180),
    tone: entry.tone === 'error' ? 'error' : entry.tone === 'skip' ? 'skip' : 'success',
    message: cleanText(entry.message, 300)
  });
  await chrome.storage.local.set({ [RULE_LOG_KEY]: logs.slice(0, MAX_LOGS) });
}

export async function listRuleLogs(limit = 20) {
  const stored = await chrome.storage.local.get(RULE_LOG_KEY);
  const logs = Array.isArray(stored[RULE_LOG_KEY]) ? stored[RULE_LOG_KEY] : [];
  return logs.slice(0, Math.max(1, Math.min(80, Number(limit) || 20)));
}

export async function clearRuleLogs() {
  await chrome.storage.local.remove(RULE_LOG_KEY);
}
