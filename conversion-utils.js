export const MAX_TEXT_CONVERSION_BYTES = 20 * 1024 * 1024;

export function extensionOf(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

export function baseName(name) {
  return String(name || 'file').replace(/\.[^.]+$/, '') || 'file';
}

export function outputName(record, extension, { forceSuffix = false, suffix = 'converted' } = {}) {
  const inputExtension = extensionOf(record?.name) === 'jpeg' ? 'jpg' : extensionOf(record?.name);
  const outputExtension = extension === 'jpeg' ? 'jpg' : extension;
  const needsSuffix = forceSuffix || inputExtension === outputExtension;
  return `${baseName(record?.name)}${needsSuffix ? `-${suffix}` : ''}.${outputExtension}`;
}

export function assertTextSize(record) {
  if (Number(record?.size || 0) > MAX_TEXT_CONVERSION_BYTES) {
    throw new Error('Structured-data conversion is limited to 20 MB.');
  }
}

export function byteSummary(inputBytes, outputBytes) {
  const before = Number(inputBytes || 0);
  const after = Number(outputBytes || 0);
  if (!before) return null;
  const delta = after - before;
  const percent = Math.abs(delta / before) * 100;
  if (Math.abs(delta) < 1024 || percent < 0.5) return 'about the same size';
  return delta < 0 ? `${percent.toFixed(percent >= 10 ? 0 : 1)}% smaller` : `${percent.toFixed(percent >= 10 ? 0 : 1)}% larger`;
}

export function scalarValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
