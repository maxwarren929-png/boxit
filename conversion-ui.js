import { listBoxes, listFiles, getFile, addBlob } from './db.js';
import {
  canConvert,
  conversionProfile,
  conversionTargets,
  suggestedConversionTarget,
  inspectConversion,
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
const summaryEl = document.querySelector('.convert-summary');
const statusEl = document.querySelector('#use-status');
const statusText = document.querySelector('#use-status-text');

let pendingRecord = null;
let pendingProfile = null;
let pendingInspection = null;
let syncing = false;
let syncDirty = false;
let statusTimer = null;

function showStatus(message, tone = 'neutral', timeout = 5000) {
  clearTimeout(statusTimer);
  statusText.textContent = message;
  statusEl.dataset.tone = tone;
  statusEl.classList.remove('hidden');
  if (timeout > 0) {
    statusTimer = setTimeout(() => {
      if (statusText.textContent === message) statusEl.classList.add('hidden');
    }, timeout);
  }
}

function addDynamicControls() {
  if (document.querySelector('#convert-v2-options')) return;

  const formatDescription = document.createElement('p');
  formatDescription.id = 'convert-format-description';
  formatDescription.className = 'convert-option-note';
  formatSelect.after(formatDescription);

  const imageAdvanced = document.createElement('div');
  imageAdvanced.id = 'convert-v2-options';
  imageAdvanced.className = 'convert-v2-options';
  imageAdvanced.innerHTML = `
    <div class="convert-v2-row">
      <label class="convert-field">
        <span>Resize mode</span>
        <select id="convert-resize-mode">
          <option value="contain">Fit within dimensions</option>
          <option value="stretch">Exact dimensions</option>
        </select>
      </label>
      <label class="convert-field">
        <span>Rotate</span>
        <select id="convert-rotation">
          <option value="0">No rotation</option>
          <option value="90">90° clockwise</option>
          <option value="180">180°</option>
          <option value="270">90° counter-clockwise</option>
        </select>
      </label>
    </div>
    <label id="convert-background-field" class="convert-field hidden">
      <span>Flatten transparency onto</span>
      <div class="convert-color-row">
        <input id="convert-background" type="color" value="#ffffff" aria-label="Background color">
        <span id="convert-background-value">#ffffff</span>
      </div>
    </label>
    <p class="convert-option-note">Image conversion redraws pixels locally, so EXIF and other embedded image metadata are removed.</p>
  `;
  imageOptions.prepend(imageAdvanced);

  const dataOptions = document.createElement('div');
  dataOptions.id = 'convert-data-options';
  dataOptions.className = 'convert-data-options hidden';
  dataOptions.innerHTML = `
    <label id="convert-header-field" class="convert-toggle-row hidden">
      <input id="convert-first-row-headers" type="checkbox" checked>
      <span>
        <strong>First row contains headers</strong>
        <small>Turn this off for headerless CSV or TSV files.</small>
      </span>
    </label>
    <label id="convert-json-style-field" class="convert-field hidden">
      <span>JSON formatting</span>
      <select id="convert-json-indent">
        <option value="2">Pretty · 2 spaces</option>
        <option value="4">Pretty · 4 spaces</option>
        <option value="0">Compact</option>
      </select>
    </label>
    <p class="convert-option-note">CSV, TSV, JSON and NDJSON all pass through the same structured-data engine, so you can convert between any of them.</p>
  `;
  summaryEl.before(dataOptions);

  const documentOptions = document.createElement('div');
  documentOptions.id = 'convert-document-options';
  documentOptions.className = 'convert-document-options hidden';
  documentOptions.innerHTML = `
    <p class="convert-option-note">DOCX conversion extracts text structure locally, including headings, lists and basic tables. Embedded images and advanced Word layout are not copied into text/Markdown/HTML outputs.</p>
  `;
  summaryEl.before(documentOptions);

  const mediaOptions = document.createElement('div');
  mediaOptions.id = 'convert-media-options';
  mediaOptions.className = 'convert-media-options hidden';
  mediaOptions.innerHTML = `
    <label id="convert-audio-options" class="convert-toggle-row hidden">
      <input id="convert-audio-mono" type="checkbox">
      <span>
        <strong>Mix down to mono</strong>
        <small>Leave off to preserve the decoded channel count in the WAV.</small>
      </span>
    </label>
    <div id="convert-video-options" class="convert-media-video hidden">
      <label class="convert-field">
        <span>Frame timestamp</span>
        <input id="convert-video-timestamp" type="number" min="0" step="0.1" value="0" inputmode="decimal">
      </label>
      <label id="convert-media-quality-field" class="convert-field hidden">
        <span>JPEG quality</span>
        <div class="convert-quality-row">
          <input id="convert-media-quality" type="range" min="10" max="100" value="90">
          <span id="convert-media-quality-value" class="convert-quality-value">90%</span>
        </div>
      </label>
      <p id="convert-media-detail" class="convert-option-note"></p>
    </div>
    <p class="convert-option-note">Media conversion uses codecs already available in Chromium. Unsupported codecs fail cleanly rather than being uploaded anywhere.</p>
  `;
  summaryEl.before(mediaOptions);

  document.querySelector('#convert-background').addEventListener('input', event => {
    document.querySelector('#convert-background-value').textContent = event.target.value;
  });
  document.querySelector('#convert-media-quality').addEventListener('input', event => {
    document.querySelector('#convert-media-quality-value').textContent = `${event.target.value}%`;
  });
}

function queueSync() {
  if (syncing) {
    syncDirty = true;
    return;
  }
  queueMicrotask(syncFileRows);
}

async function syncFileRows() {
  if (syncing) {
    syncDirty = true;
    return;
  }
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
          const download = actions?.querySelector('.download-file');
          if (actions) actions.insertBefore(button, download || actions.firstChild);
        }
      }
    }
  } finally {
    syncing = false;
    if (syncDirty) {
      syncDirty = false;
      queueMicrotask(syncFileRows);
    }
  }
}

function resetDialog() {
  form.reset();
  formatSelect.replaceChildren();
  maxWidthInput.value = '';
  maxHeightInput.value = '';
  maxWidthInput.placeholder = 'Original';
  maxHeightInput.placeholder = 'Original';
  qualityInput.value = '90';
  qualityValue.textContent = '90%';
  document.querySelector('#convert-resize-mode').value = 'contain';
  document.querySelector('#convert-rotation').value = '0';
  document.querySelector('#convert-background').value = '#ffffff';
  document.querySelector('#convert-background-value').textContent = '#ffffff';
  document.querySelector('#convert-first-row-headers').checked = true;
  document.querySelector('#convert-json-indent').value = '2';
  document.querySelector('#convert-audio-mono').checked = false;
  document.querySelector('#convert-video-timestamp').value = '0';
  document.querySelector('#convert-video-timestamp').removeAttribute('max');
  document.querySelector('#convert-media-quality').value = '90';
  document.querySelector('#convert-media-quality-value').textContent = '90%';
  document.querySelector('#convert-media-detail').textContent = '';
  document.querySelector('#convert-format-description').textContent = '';
  dimensionsNote.textContent = 'Leave both blank to keep the original dimensions.';
  summaryEl.textContent = 'Conversion happens locally. The original file stays untouched and the converted copy is saved into the same box.';
  pendingRecord = null;
  pendingProfile = null;
  pendingInspection = null;
}

function selectedTarget() {
  return conversionTargets(pendingRecord).find(target => target.value === formatSelect.value) || null;
}

function updateOptionVisibility() {
  const target = selectedTarget();
  document.querySelector('#convert-format-description').textContent = target?.description || '';

  const isImage = pendingProfile?.id === 'image';
  const isTable = pendingProfile?.id === 'table';
  const isDocument = pendingProfile?.id === 'document';
  const isMedia = pendingProfile?.id === 'media';
  imageOptions.classList.toggle('hidden', !isImage);
  document.querySelector('#convert-data-options').classList.toggle('hidden', !isTable);
  document.querySelector('#convert-document-options').classList.toggle('hidden', !isDocument);
  document.querySelector('#convert-media-options').classList.toggle('hidden', !isMedia);

  if (isImage) {
    const lossy = ['jpeg', 'webp'].includes(formatSelect.value);
    qualityField.classList.toggle('hidden', !lossy);
    document.querySelector('#convert-background-field').classList.toggle('hidden', !['jpeg', 'bmp'].includes(formatSelect.value));
    summaryEl.textContent = 'Local pixel conversion. The original is preserved; image metadata is stripped from the new copy.';
  }

  if (isTable) {
    const source = pendingInspection?.sourceFormat;
    document.querySelector('#convert-header-field').classList.toggle('hidden', !['csv', 'tsv'].includes(source));
    document.querySelector('#convert-json-style-field').classList.toggle('hidden', formatSelect.value !== 'json');
    summaryEl.textContent = 'Local structured-data conversion. Nested values are preserved as JSON strings when a table format cannot represent them directly.';
  }

  if (isDocument) {
    summaryEl.textContent = pendingInspection?.sourceFormat === 'docx'
      ? 'Local DOCX text extraction. The original Word file is preserved.'
      : 'Local document normalization. The original file is preserved.';
  }

  if (isMedia) {
    const audio = pendingInspection?.kind === 'audio';
    const video = pendingInspection?.kind === 'video';
    document.querySelector('#convert-audio-options').classList.toggle('hidden', !audio);
    document.querySelector('#convert-video-options').classList.toggle('hidden', !video);
    document.querySelector('#convert-media-quality-field').classList.toggle('hidden', !(video && formatSelect.value === 'jpeg'));
    summaryEl.textContent = audio
      ? 'Audio is decoded locally and written as 16-bit PCM WAV.'
      : 'Video stays intact; BoxIt extracts one still frame locally at the chosen timestamp.';
  }
}

async function openConvertDialog(record) {
  pendingRecord = record;
  pendingProfile = conversionProfile(record);
  if (!pendingProfile) throw new Error('BoxIt does not have a converter for this file yet.');
  fileNameEl.textContent = record.name;
  formatSelect.replaceChildren();

  const targets = conversionTargets(record);
  for (const target of targets) {
    const option = document.createElement('option');
    option.value = target.value;
    option.textContent = target.label;
    formatSelect.append(option);
  }
  formatSelect.value = suggestedConversionTarget(record) || targets[0]?.value || '';

  pendingInspection = await inspectConversion(record);
  if (pendingProfile.id === 'image' && pendingInspection) {
    maxWidthInput.placeholder = String(pendingInspection.width || 'Original');
    maxHeightInput.placeholder = String(pendingInspection.height || 'Original');
    dimensionsNote.textContent = `Original: ${pendingInspection.width}×${pendingInspection.height}. Fit mode preserves aspect ratio and never upscales.`;
  }
  if (pendingProfile.id === 'media' && pendingInspection) {
    const duration = Number(pendingInspection.duration || 0);
    if (pendingInspection.kind === 'video') {
      const timestamp = document.querySelector('#convert-video-timestamp');
      if (duration > 0) timestamp.max = String(Math.max(0, duration - 0.001));
      const size = pendingInspection.width && pendingInspection.height ? `${pendingInspection.width}×${pendingInspection.height}` : 'unknown dimensions';
      document.querySelector('#convert-media-detail').textContent = `${size}${duration > 0 ? ` · ${duration.toFixed(1)}s` : ''}`;
    }
  }

  updateOptionVisibility();
  dialog.showModal();
  requestAnimationFrame(() => formatSelect.focus());
}

async function convertPending() {
  if (!pendingRecord) return;
  submitButton.disabled = true;
  submitButton.textContent = 'Converting…';
  try {
    const options = {
      format: formatSelect.value,
      maxWidth: maxWidthInput.value ? Number(maxWidthInput.value) : undefined,
      maxHeight: maxHeightInput.value ? Number(maxHeightInput.value) : undefined,
      resizeMode: document.querySelector('#convert-resize-mode').value,
      rotation: Number(document.querySelector('#convert-rotation').value),
      quality: Number(qualityInput.value),
      background: document.querySelector('#convert-background').value,
      firstRowHeaders: document.querySelector('#convert-first-row-headers').checked,
      jsonIndent: Number(document.querySelector('#convert-json-indent').value),
      audioChannels: document.querySelector('#convert-audio-mono').checked ? 'mono' : 'keep',
      timestamp: Number(document.querySelector('#convert-video-timestamp').value || 0),
      mediaQuality: Number(document.querySelector('#convert-media-quality').value || 90)
    };

    const result = await convertRecord(pendingRecord, options);
    const saved = await addBlob(pendingRecord.boxId, result.blob, result.name, { source: 'conversion-v2' });
    const sizePart = result.sizeNote ? ` · ${result.sizeNote}` : '';
    await chrome.storage.local.set({
      [LAST_CONVERSION_KEY]: {
        fileName: saved.name,
        summary: `${result.summary}${sizePart}`,
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
  const fileId = row?.dataset.fileId || row?.dataset.safeFileId || row?.dataset.qolFileId;
  if (!fileId) {
    showStatus('BoxIt could not identify that file. Reopen the popup and try again.', 'error');
    return;
  }

  button.disabled = true;
  button.textContent = 'Opening…';
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

formatSelect.addEventListener('change', updateOptionVisibility);
qualityInput.addEventListener('input', () => { qualityValue.textContent = `${qualityInput.value}%`; });
cancelButton.addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => {
  submitButton.disabled = false;
  submitButton.textContent = 'Convert';
  resetDialog();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  await convertPending();
});

addDynamicControls();
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
