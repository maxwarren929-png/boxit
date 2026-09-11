import { extensionOf, outputName } from './conversion-utils.js';

const MAX_CANVAS_DIMENSION = 16384;
const MAX_CANVAS_PIXELS = 80_000_000;

const INPUT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/avif'
]);
const INPUT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg', 'bmp', 'avif']);

const TARGETS = {
  png: { value: 'png', label: 'PNG', mime: 'image/png', extension: 'png', description: 'Lossless, keeps transparency.' },
  jpeg: { value: 'jpeg', label: 'JPEG', mime: 'image/jpeg', extension: 'jpg', description: 'Small photographic files, no transparency.' },
  webp: { value: 'webp', label: 'WebP', mime: 'image/webp', extension: 'webp', description: 'Modern compressed image with transparency support.' },
  bmp: { value: 'bmp', label: 'BMP', mime: 'image/bmp', extension: 'bmp', description: 'Uncompressed bitmap for compatibility.' }
};

export function imageLike(record) {
  const type = String(record?.type || '').toLowerCase();
  return INPUT_TYPES.has(type) || INPUT_EXTENSIONS.has(extensionOf(record?.name));
}

async function decodeImage(blob) {
  if ('createImageBitmap' in globalThis) {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
    } catch {}
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({
        source: image,
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        close: () => {}
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This image format could not be decoded by the browser.'));
    };
    image.src = url;
  });
}

function clampDimension(value) {
  return Math.max(1, Math.min(MAX_CANVAS_DIMENSION, Math.round(Number(value) || 1)));
}

function containedSize(width, height, maxWidth, maxHeight) {
  const sourceWidth = Math.max(1, Number(width) || 1);
  const sourceHeight = Math.max(1, Number(height) || 1);
  const widthLimit = Number(maxWidth) > 0 ? Math.min(Number(maxWidth), MAX_CANVAS_DIMENSION) : sourceWidth;
  const heightLimit = Number(maxHeight) > 0 ? Math.min(Number(maxHeight), MAX_CANVAS_DIMENSION) : sourceHeight;
  let scale = Math.min(1, widthLimit / sourceWidth, heightLimit / sourceHeight);
  const pixels = sourceWidth * sourceHeight * scale * scale;
  if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
  return {
    width: clampDimension(sourceWidth * scale),
    height: clampDimension(sourceHeight * scale)
  };
}

function stretchedSize(width, height, requestedWidth, requestedHeight) {
  let outWidth = Number(requestedWidth) > 0 ? Math.min(Number(requestedWidth), width, MAX_CANVAS_DIMENSION) : width;
  let outHeight = Number(requestedHeight) > 0 ? Math.min(Number(requestedHeight), height, MAX_CANVAS_DIMENSION) : height;
  outWidth = clampDimension(outWidth);
  outHeight = clampDimension(outHeight);
  const pixels = outWidth * outHeight;
  if (pixels > MAX_CANVAS_PIXELS) {
    const scale = Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    outWidth = clampDimension(outWidth * scale);
    outHeight = clampDimension(outHeight * scale);
  }
  return { width: outWidth, height: outHeight };
}

function canvasBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('The browser could not encode the converted image.'));
    }, mime, quality);
  });
}

function encodeBmp(context, width, height) {
  const image = context.getImageData(0, 0, width, height);
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const fileSize = 54 + pixelBytes;
  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint16(0, 0x4d42, true);
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelBytes, true);

  let offset = 54;
  for (let y = height - 1; y >= 0; y -= 1) {
    const rowStart = offset;
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4;
      bytes[offset++] = image.data[src + 2];
      bytes[offset++] = image.data[src + 1];
      bytes[offset++] = image.data[src];
    }
    while (offset - rowStart < rowSize) bytes[offset++] = 0;
  }

  return new Blob([buffer], { type: 'image/bmp' });
}

function normalizeRotation(value) {
  const rotation = Number(value) || 0;
  return [0, 90, 180, 270].includes(rotation) ? rotation : 0;
}

export async function imageDimensions(blob) {
  const decoded = await decodeImage(blob);
  try {
    return { width: decoded.width, height: decoded.height };
  } finally {
    decoded.close();
  }
}

async function convertImage(record, options = {}) {
  const target = TARGETS[options.format] || TARGETS.png;
  const decoded = await decodeImage(record.blob);
  try {
    const sourceWidth = decoded.width;
    const sourceHeight = decoded.height;
    const resizeMode = options.resizeMode === 'stretch' ? 'stretch' : 'contain';
    const drawSize = resizeMode === 'stretch'
      ? stretchedSize(sourceWidth, sourceHeight, options.maxWidth, options.maxHeight)
      : containedSize(sourceWidth, sourceHeight, options.maxWidth, options.maxHeight);

    const rotation = normalizeRotation(options.rotation);
    const rotated = rotation === 90 || rotation === 270;
    const canvasWidth = rotated ? drawSize.height : drawSize.width;
    const canvasHeight = rotated ? drawSize.width : drawSize.height;

    if (canvasWidth * canvasHeight > MAX_CANVAS_PIXELS) {
      throw new Error('The converted image would be too large for the browser canvas.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const flatten = target.value === 'jpeg' || target.value === 'bmp';
    const context = canvas.getContext('2d', { alpha: !flatten, willReadFrequently: target.value === 'bmp' });
    if (!context) throw new Error('BoxIt could not create an image conversion canvas.');

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    if (flatten) {
      context.fillStyle = options.background || '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }

    context.save();
    if (rotation === 90) {
      context.translate(canvas.width, 0);
      context.rotate(Math.PI / 2);
    } else if (rotation === 180) {
      context.translate(canvas.width, canvas.height);
      context.rotate(Math.PI);
    } else if (rotation === 270) {
      context.translate(0, canvas.height);
      context.rotate(-Math.PI / 2);
    }
    context.drawImage(decoded.source, 0, 0, drawSize.width, drawSize.height);
    context.restore();

    const qualityPercent = Math.max(10, Math.min(100, Number(options.quality) || 90));
    const blob = target.value === 'bmp'
      ? encodeBmp(context, canvas.width, canvas.height)
      : await canvasBlob(canvas, target.mime, target.value === 'png' ? undefined : qualityPercent / 100);

    const transformed = canvas.width !== sourceWidth || canvas.height !== sourceHeight || rotation !== 0;
    return {
      blob,
      name: outputName(record, target.extension, {
        forceSuffix: transformed || extensionOf(record.name) === target.extension,
        suffix: 'converted'
      }),
      summary: `${target.label} · ${canvas.width}×${canvas.height}`,
      warnings: ['Image metadata is stripped during conversion.'],
      details: { width: canvas.width, height: canvas.height, rotation }
    };
  } finally {
    decoded.close();
  }
}

export const imageConverter = {
  id: 'image',
  label: 'Image',
  matches: imageLike,
  targets() {
    return Object.values(TARGETS).map(({ value, label, description }) => ({ value, label, description }));
  },
  suggestedTarget(record) {
    const ext = extensionOf(record?.name);
    if (ext === 'png') return 'webp';
    if (ext === 'webp') return 'png';
    if (ext === 'jpg' || ext === 'jpeg') return 'webp';
    return 'png';
  },
  inspect: async record => ({ kind: 'image', ...(await imageDimensions(record.blob)) }),
  convert: convertImage
};
