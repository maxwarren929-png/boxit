const IMAGE_OUTPUTS = {
  png: { mime: 'image/png', extension: 'png', label: 'PNG' },
  jpeg: { mime: 'image/jpeg', extension: 'jpg', label: 'JPEG' },
  webp: { mime: 'image/webp', extension: 'webp', label: 'WebP' }
};

const IMAGE_INPUT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/avif'
]);

const IMAGE_INPUT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg', 'bmp', 'avif']);
const MAX_CANVAS_DIMENSION = 16384;
const MAX_CANVAS_PIXELS = 80_000_000;
const MAX_TEXT_CONVERSION_BYTES = 20 * 1024 * 1024;

function extensionOf(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

function baseName(name) {
  return String(name || 'file').replace(/\.[^.]+$/, '') || 'file';
}

function imageLike(record) {
  const type = String(record?.type || '').toLowerCase();
  const extension = extensionOf(record?.name);
  return IMAGE_INPUT_TYPES.has(type) || IMAGE_INPUT_EXTENSIONS.has(extension);
}

function jsonLike(record) {
  const type = String(record?.type || '').toLowerCase();
  return type === 'application/json' || type.endsWith('+json') || extensionOf(record?.name) === 'json';
}

function csvLike(record) {
  const type = String(record?.type || '').toLowerCase();
  return type === 'text/csv' || extensionOf(record?.name) === 'csv';
}

export function conversionKind(record) {
  if (imageLike(record)) return 'image';
  if (jsonLike(record)) return 'json';
  if (csvLike(record)) return 'csv';
  return null;
}

export function canConvert(record) {
  return conversionKind(record) !== null;
}

export function conversionTargets(record) {
  const kind = conversionKind(record);
  if (kind === 'image') {
    return Object.entries(IMAGE_OUTPUTS).map(([value, info]) => ({ value, label: info.label }));
  }
  if (kind === 'json') return [{ value: 'csv', label: 'CSV' }];
  if (kind === 'csv') return [{ value: 'json', label: 'JSON' }];
  return [];
}

export function suggestedImageTarget(record) {
  const extension = extensionOf(record?.name);
  if (extension === 'png') return 'webp';
  if (extension === 'webp') return 'png';
  return 'png';
}

function outputName(record, extension, forceSuffix = false) {
  const inputExtension = extensionOf(record?.name);
  const normalizedInput = inputExtension === 'jpeg' ? 'jpg' : inputExtension;
  const normalizedOutput = extension === 'jpeg' ? 'jpg' : extension;
  const suffix = forceSuffix || normalizedInput === normalizedOutput ? '-converted' : '';
  return `${baseName(record?.name)}${suffix}.${normalizedOutput}`;
}

function imageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This image format could not be decoded by the browser.'));
    };
    image.src = url;
  });
}

function containedSize(width, height, maxWidth, maxHeight) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  const requestedWidth = Number(maxWidth) > 0 ? Number(maxWidth) : safeWidth;
  const requestedHeight = Number(maxHeight) > 0 ? Number(maxHeight) : safeHeight;
  const widthLimit = Math.min(requestedWidth, MAX_CANVAS_DIMENSION);
  const heightLimit = Math.min(requestedHeight, MAX_CANVAS_DIMENSION);
  let scale = Math.min(1, widthLimit / safeWidth, heightLimit / safeHeight);

  const scaledPixels = safeWidth * safeHeight * scale * scale;
  if (scaledPixels > MAX_CANVAS_PIXELS) {
    scale *= Math.sqrt(MAX_CANVAS_PIXELS / scaledPixels);
  }

  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale))
  };
}

function canvasBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('The browser could not encode the converted image.'));
    }, mime, quality);
  });
}

function assertTextSize(record) {
  if (Number(record?.size || 0) > MAX_TEXT_CONVERSION_BYTES) {
    throw new Error('JSON/CSV conversion is limited to 20 MB in this MVP.');
  }
}

export async function imageDimensions(blob) {
  const image = await imageFromBlob(blob);
  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height
  };
}

export async function convertImage(record, options = {}) {
  const target = IMAGE_OUTPUTS[options.format] || IMAGE_OUTPUTS.png;
  const image = await imageFromBlob(record.blob);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const size = containedSize(sourceWidth, sourceHeight, options.maxWidth, options.maxHeight);

  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d', { alpha: target.mime !== 'image/jpeg' });
  if (!context) throw new Error('BoxIt could not create an image converter.');

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  if (target.mime === 'image/jpeg') {
    context.fillStyle = options.background || '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
  }
  context.drawImage(image, 0, 0, size.width, size.height);

  const qualityPercent = Math.max(10, Math.min(100, Number(options.quality) || 90));
  const quality = target.mime === 'image/png' ? undefined : qualityPercent / 100;
  const blob = await canvasBlob(canvas, target.mime, quality);
  const resized = size.width !== sourceWidth || size.height !== sourceHeight;

  return {
    blob,
    name: outputName(record, target.extension, resized || extensionOf(record.name) === target.extension),
    summary: `${target.label} · ${size.width}×${size.height}`,
    width: size.width,
    height: size.height
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (quoted) throw new Error('The CSV contains an unfinished quoted value.');
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }

  return rows.filter((entry, index) => index === 0 || entry.some(value => value !== ''));
}

function uniqueHeaders(headers) {
  const used = new Map();
  return headers.map((header, index) => {
    const base = String(header || '').trim() || `column_${index + 1}`;
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function scalarValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function csvEscape(value) {
  const text = scalarValue(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function jsonArrayToCsv(value) {
  if (!Array.isArray(value)) throw new Error('JSON must contain an array to convert to CSV.');
  if (value.length === 0) return '';

  const objects = value.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry));
  if (objects) {
    const headers = [];
    const seen = new Set();
    for (const entry of value) {
      for (const key of Object.keys(entry)) {
        if (!seen.has(key)) {
          seen.add(key);
          headers.push(key);
        }
      }
    }
    const lines = [headers.map(csvEscape).join(',')];
    for (const entry of value) {
      lines.push(headers.map(header => csvEscape(entry[header])).join(','));
    }
    return lines.join('\n');
  }

  const arrays = value.every(entry => Array.isArray(entry));
  if (arrays) return value.map(row => row.map(csvEscape).join(',')).join('\n');

  return ['value', ...value.map(entry => csvEscape(entry))].join('\n');
}

export async function convertJsonToCsv(record) {
  assertTextSize(record);
  let parsed;
  try {
    parsed = JSON.parse(await record.blob.text());
  } catch {
    throw new Error('This file is not valid JSON.');
  }

  const csv = jsonArrayToCsv(parsed);
  return {
    blob: new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    name: outputName(record, 'csv'),
    summary: 'CSV'
  };
}

export async function convertCsvToJson(record) {
  assertTextSize(record);
  const rows = parseCsv(await record.blob.text());
  if (!rows.length) {
    return {
      blob: new Blob(['[]\n'], { type: 'application/json' }),
      name: outputName(record, 'json'),
      summary: 'JSON · 0 rows'
    };
  }

  const headers = uniqueHeaders(rows[0]);
  const values = rows.slice(1).map(row => Object.fromEntries(
    headers.map((header, index) => [header, row[index] ?? ''])
  ));
  const json = `${JSON.stringify(values, null, 2)}\n`;

  return {
    blob: new Blob([json], { type: 'application/json' }),
    name: outputName(record, 'json'),
    summary: `JSON · ${values.length} row${values.length === 1 ? '' : 's'}`
  };
}

export async function convertRecord(record, options = {}) {
  const kind = conversionKind(record);
  if (kind === 'image') return convertImage(record, options);
  if (kind === 'json' && options.format === 'csv') return convertJsonToCsv(record);
  if (kind === 'csv' && options.format === 'json') return convertCsvToJson(record);
  throw new Error('BoxIt does not have a converter for this file yet.');
}
