import { imageConverter, imageDimensions } from './conversion-image.js';
import { tableConverter } from './conversion-table.js';
import { documentConverter } from './conversion-document.js';
import { mediaConverter } from './conversion-media.js';
import { byteSummary } from './conversion-utils.js';

const CONVERTERS = [imageConverter, tableConverter, documentConverter, mediaConverter];

function converterFor(record) {
  return CONVERTERS.find(converter => converter.matches(record)) || null;
}

export function conversionKind(record) {
  return converterFor(record)?.id || null;
}

export function canConvert(record) {
  return converterFor(record) !== null;
}

export function conversionTargets(record) {
  return converterFor(record)?.targets(record) || [];
}

export function suggestedConversionTarget(record) {
  return converterFor(record)?.suggestedTarget(record) || '';
}

export function suggestedImageTarget(record) {
  return imageConverter.matches(record) ? imageConverter.suggestedTarget(record) : '';
}

export function conversionProfile(record) {
  const converter = converterFor(record);
  if (!converter) return null;
  return { id: converter.id, label: converter.label };
}

export async function inspectConversion(record) {
  const converter = converterFor(record);
  if (!converter) return null;
  return converter.inspect ? converter.inspect(record) : { kind: converter.id };
}

export { imageDimensions };

export async function convertRecord(record, options = {}) {
  const converter = converterFor(record);
  if (!converter) throw new Error('BoxIt does not have a converter for this file yet.');
  const result = await converter.convert(record, options);
  const sizeNote = byteSummary(record.size, result.blob?.size);
  return {
    ...result,
    inputBytes: Number(record.size || 0),
    outputBytes: Number(result.blob?.size || 0),
    sizeNote
  };
}
