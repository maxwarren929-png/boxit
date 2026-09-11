chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'BOXIT_USE_FILE') return;

  const inputs = [...document.querySelectorAll('input[type="file"]')]
    .filter(input => !input.disabled && input.offsetParent !== null);

  const input = inputs[0];
  if (!input) {
    sendResponse({ ok: false, error: 'No visible file input found.' });
    return;
  }

  try {
    const { name, type, lastModified, bytes } = message.file;
    const file = new File([new Uint8Array(bytes)], name, { type, lastModified });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }

  return true;
});
