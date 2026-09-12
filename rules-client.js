export async function runRuleScan(context = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'BOXIT_RULE_SCAN', context });
    return response?.ok ? response : { ok: false, error: response?.error || 'Rules scan failed.' };
  } catch (error) {
    return { ok: false, error: error?.message || 'Rules scan failed.' };
  }
}
