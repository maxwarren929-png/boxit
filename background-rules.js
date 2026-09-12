import './background-v2.js';
import {
  expireDueFiles,
  RULE_FILE_EXPIRY_ALARM,
  RULE_PERIODIC_SCAN_ALARM,
  RULE_SCAN_ALARM,
  scanPendingFiles,
  scheduleNextFileExpiry
} from './rules-engine.js';

function scheduleRuleScan(delayMs = 700) {
  chrome.alarms.create(RULE_SCAN_ALARM, { when: Date.now() + Math.max(100, delayMs) });
}

async function ensureRuleMaintenance() {
  const existing = await chrome.alarms.get(RULE_PERIODIC_SCAN_ALARM);
  if (!existing) chrome.alarms.create(RULE_PERIODIC_SCAN_ALARM, { periodInMinutes: 1 });
  await expireDueFiles();
  await scheduleNextFileExpiry();
  const result = await scanPendingFiles();
  if (result.remaining > 0) scheduleRuleScan(500);
}

chrome.runtime.onInstalled.addListener(() => {
  ensureRuleMaintenance().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  ensureRuleMaintenance().catch(console.error);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!['boxit-save-image', 'boxit-save-link'].includes(info.menuItemId)) return;
  const sourceUrl = info.srcUrl || info.linkUrl || '';
  const source = info.menuItemId === 'boxit-save-image' ? 'context-image' : 'context-link';
  chrome.storage.session.set({ boxitRuleCaptureHint: { source, sourceUrl, pageUrl: tab?.url || '', at: Date.now() } }).catch(() => {});
  scheduleRuleScan(900);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'BOXIT_RULE_SCAN') {
    scanPendingFiles(message.context || {})
      .then(result => {
        if (result.remaining > 0) scheduleRuleScan(400);
        sendResponse({ ok: true, ...result });
      })
      .catch(error => sendResponse({ ok: false, error: error?.message || 'BoxIt rules could not run.' }));
    return true;
  }

  if (message?.type === 'BOXIT_CAPTURE_REMOTE_URL') {
    const hint = {
      source: message.source || 'web-drop',
      sourceUrl: message.url || '',
      pageUrl: message.pageUrl || '',
      at: Date.now()
    };
    chrome.storage.session.set({ boxitRuleCaptureHint: hint }).catch(() => {});
    scheduleRuleScan(900);
  }
});

chrome.alarms.onAlarm.addListener(async alarm => {
  try {
    if (alarm.name === RULE_FILE_EXPIRY_ALARM) {
      await expireDueFiles();
      return;
    }
    if (alarm.name === RULE_SCAN_ALARM || alarm.name === RULE_PERIODIC_SCAN_ALARM) {
      const stored = await chrome.storage.session.get('boxitRuleCaptureHint').catch(() => ({}));
      const hint = stored.boxitRuleCaptureHint;
      const freshHint = hint && Date.now() - Number(hint.at || 0) < 15000 ? hint : {};
      const result = await scanPendingFiles(freshHint);
      if (hint) await chrome.storage.session.remove('boxitRuleCaptureHint').catch(() => {});
      if (result.remaining > 0) scheduleRuleScan(400);
    }
  } catch (error) {
    console.error(error);
  }
});

ensureRuleMaintenance().catch(console.error);
