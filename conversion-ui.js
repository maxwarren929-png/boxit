import { listBoxes, listFiles, getFile, addBlob } from './db.js';
import {
  canConvert,
  conversionKind,
  conversionTargets,
  suggestedImageTarget,
  imageDimensions,
  convertRecord
} from './conversion.js';

const LAST_CONVERSION_KEY = 'boxitLastConversion';

const boxesEl = document.querySelector('#boxes');
const dialog = document.querySelector('#convert-dialog');
const form = document.querySelector('#convert-form');
const fileNameEl = document.querySelector('#convert-file-name');
const formatSelect = document.querySelector('#convert-format');
const imageOptions = document.querySelector('#convert-image-options');
const maxWidthInput = document.querySelector('#convert-max-width');
const maxHeightInput = document.querySelector('#convert-max-height');
const dimensionsNote = document.querySelector('#convert-dimensions-note');
const qualityField = document.querySelector('#convert-quality-field');
const qualityInput = document.querySelector('#convert-quality');
const qualityValue = document.querySelector('#convert-quality-value');
const cancelButton = document.querySelector('#cancel-convert');
const submitButton = document.querySelector('#convert-submit');
const statusEl = document.querySelector('#use-status');
const statusText = document.querySelector('#use-status-text');

let pendingRecord = null;
let syncing = false;
let syncQueued = false;
let statusTimer = null;

function showStatus(message, tone = 'neutral', timeout = 5000) {
  clearTimeout(statusTimer);
  statusText.textContent = message;
  statusEl.dataset.tone = tone;
  statusEl.classList.remove('hidden');
  if (timeout > 0) {
    statusTimer = setTimeout(() => statusEl.classList.add('hidden'), timeout);
  }
}

function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(async () => {
    syncQueued = false;
    await syncFileRows();
  });
}

async function syncFileRows() {
  if (syncing) return;
  syncing = true;
  try {
    const boxes = await listBoxes();
    const cards = [...boxesEl.querySelectorAll('.box-card')];

    for (let boxIndex = 0; boxIndex < Math.min(boxes.length, cards.length); boxIndex += 1) {
      const files = await listFiles(boxes[boxIndex].id);
      const rows = [...cards[boxIndex].querySelectorAll('.file-row')];

      for (let fileIndex = 0; fileIndex < Math.min(files.length, rows.length); fileIndex += 1) {
        const record = files[fileIndex];
        const row = rows[fileIndex];
        row.dataset.fileId = record.id;

        let button = row.querySelector('.convert-file');
        if (!canConvert(record)) {
          button?.remove();
          continue;
        }

        if (!button) {
          button = document.createElement('button');
          button.type = 'button';
          button.className = 'button button-file button-file-convert convert-file';
          button.textContent = 'Convert';
          const actions = row.querySelector('.file-actions');
          const downloadButton = actions?.querySelector('.download-file');
          if (actions) actions.insertBefore(button, downloadButton || actions.firstChild);
        }
      }
    }
  } finally {
    syncing = false;
  }
}

function resetDialog() {
  form.reset();
  formatSelect.replaceChildren();
  maxWidthInput.value = '';
  maxHeightInput.value = '';
  qualityInput.value = '90';
  qualityValue.textContent = '90%';
  dimensionsNote.textContent = 'Leave both blank to keep the original dimensions.';
  pendingRecord = null;
}

function updateQualityVisibility() {
  const lossy = ['jpeg', 'webp'].includes(formatSelect.value);
  qualityField.classList.toggle('hidden', !lossy);
}

async function openConvertDialog(record) {
  pendingRecord = record;
  fileNameEl.textContent = record.name;
  formatSelect.replaceChildren();

  const targets = conversionTargets(record);
  for (const target of targets) {
    const option = document.createElement('option');
    option.value = target.value;
    option.textContent = target.label;
    formatSelect.append(option);
  }

  const kind = conversionKind(record);
  const isImage = kind === 'image';
  imageOptions.classList.toggle('hidden', !isImage);

  if (isImage) {
    formatSelect.value = suggestedImageTarget(record);
    if (!formatSelect.value && targets.length) formatSelect.value = targets[0].value;
    dimensionsNote.textContent = 'Reading image dimensions...';
    try {
      const dimensions = await imageDimensions(record.blob);
      maxWidthInput.placeholder = String(dimensions.width);
      maxHeightInput.placeholder = String(dimensions.height);
      dimensionsNote.textContent = `Original: ${dimensions.width}×${dimensions.height}. Limits preserve aspect ratio and never upscale.`;
    } catch {
      maxWidthInput.placeholder = '';
      maxHeightInput.placeholder = '';
      dimensionsNote.textContent = 'Leave both blank to keep the original dimensions.';
    }
  }

  updateQualityVisibility();
  dialog.showModal();
  requestAnimationFrame(() => formatSelect.focus());
}

async function convertPending() {
  if (!pendingRecord) return;

  submitButton.disabled = true;
  submitButton.textContent = 'Converting...';

  try {
    const options = {
      format: formatSelect.value,
      maxWidth: maxWidthInput.value ? Number(maxWidthInput.value) : undefined,
      maxHeight: maxHeightInput.value ? Number(maxHeightInput.value) : undefined,
      quality: Number(qualityInput.value)
    };

    const result = await convertRecord(pendingRecord, options);
    const saved = await addBlob(pendingRecord.boxId, result.blob, result.name, {
      source: 'conversion'
    });

    await chrome.storage.local.set({
      [LAST_CONVERSION_KEY]: {
        fileName: saved.name,
        summary: result.summary,
        convertedAt: Date.now()
      }
    });

    dialog.close();
    window.location.reload();
  } catch (error) {
    showStatus(error?.message || 'BoxIt could not convert this file.', 'error', 7000);
    submitButton.disabled = false;
    submitButton.textContent = 'Convert';
  }
}

boxesEl.addEventListener('click', async event => {
  const button = event.target.closest('.convert-file');
  if (!button) return;
  const row = button.closest('.file-row');
  const fileId = row?.dataset.fileId;
  if (!fileId) {
    showStatus('BoxIt could not identify that file. Reopen the popup and try again.', 'error');
    return;
  }

  button.disabled = true;
  button.textContent = 'Opening...';
  try {
    const record = await getFile(fileId);
    if (!record) throw new Error('That file is no longer available in BoxIt.');
    await openConvertDialog(record);
  } catch (error) {
    showStatus(error?.message || 'BoxIt could not open the converter.', 'error', 7000);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = 'Convert';
    }
  }
});

formatSelect.addEventListener('change', updateQualityVisibility);
qualityInput.addEventListener('input', () => {
  qualityValue.textContent = `${qualityInput.value}%`;
});
cancelButton.addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
});
dialog.addEventListener('close', () => {
  submitButton.disabled = false;
  submitButton.textContent = 'Convert';
  resetDialog();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  await convertPending();
});

const observer = new MutationObserver(queueSync);
observer.observe(boxesEl, { childList: true, subtree: true });

async function showRecentConversion() {
  const stored = await chrome.storage.local.get(LAST_CONVERSION_KEY);
  const conversion = stored[LAST_CONVERSION_KEY];
  if (!conversion) return;

  const recent = Date.now() - Number(conversion.convertedAt || 0) < 30000;
  if (recent && conversion.fileName) {
    const detail = conversion.summary ? ` (${conversion.summary})` : '';
    showStatus(`Created ${conversion.fileName}${detail}.`, 'success', 7000);
  }
  await chrome.storage.local.remove(LAST_CONVERSION_KEY);
}

await showRecentConversion();
await syncFileRows();
