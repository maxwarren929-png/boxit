import { assertTextSize, extensionOf, outputName, scalarValue } from './conversion-utils.js';

const FORMATS = {
  json: { value: 'json', label: 'JSON', extension: 'json', mime: 'application/json', description: 'A JSON array of rows or values.' },
  ndjson: { value: 'ndjson', label: 'NDJSON', extension: 'ndjson', mime: 'application/x-ndjson', description: 'One JSON value per line, good for streaming.' },
  csv: { value: 'csv', label: 'CSV', extension: 'csv', mime: 'text/csv', description: 'Comma-separated table.' },
  tsv: { value: 'tsv', label: 'TSV', extension: 'tsv', mime: 'text/tab-separated-values', description: 'Tab-separated table.' }
};

function sourceFormat(record) {
  const type = String(record?.type || '').split(';')[0].trim().toLowerCase();
  const ext = extensionOf(record?.name);
  if (type === 'application/json' || type.endsWith('+json') || ext === 'json') return 'json';
  if (type === 'application/x-ndjson' || type === 'application/ndjson' || ext === 'ndjson' || ext === 'jsonl') return 'ndjson';
  if (type === 'text/csv' || ext === 'csv') return 'csv';
  if (type === 'text/tab-separated-values' || ext === 'tsv') return 'tsv';
  return null;
}

function parseDelimited(text, delimiter) {
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
    if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }

  if (quoted) throw new Error('The table contains an unfinished quoted value.');
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

function maxRowWidth(rows) {
  let width = 0;
  for (const row of rows) width = Math.max(width, row.length);
  return width;
}

function rowsToObjects(rows, firstRowHeaders) {
  if (!rows.length) return [];
  const width = maxRowWidth(rows);
  const headers = firstRowHeaders
    ? uniqueHeaders(rows[0])
    : Array.from({ length: width }, (_, index) => `column_${index + 1}`);
  const dataRows = firstRowHeaders ? rows.slice(1) : rows;
  return dataRows.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
}

function normalizeJsonRoot(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [value];
}

async function parseSource(record, options) {
  assertTextSize(record);
  const source = sourceFormat(record);
  const text = await record.blob.text();
  if (source === 'json') {
    try {
      return normalizeJsonRoot(JSON.parse(text));
    } catch {
      throw new Error('This file is not valid JSON.');
    }
  }
  if (source === 'ndjson') {
    const items = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        items.push(JSON.parse(line));
      } catch {
        throw new Error(`NDJSON line ${index + 1} is not valid JSON.`);
      }
    }
    return items;
  }
  if (source === 'csv' || source === 'tsv') {
    const delimiter = source === 'csv' ? ',' : '\t';
    return rowsToObjects(parseDelimited(text, delimiter), options.firstRowHeaders !== false);
  }
  throw new Error('BoxIt could not identify this structured-data format.');
}

function tableShape(items) {
  const objectRows = items.every(item => item && typeof item === 'object' && !Array.isArray(item));
  if (objectRows) {
    const headers = [];
    const seen = new Set();
    for (const item of items) {
      for (const key of Object.keys(item)) {
        if (!seen.has(key)) {
          seen.add(key);
          headers.push(key);
        }
      }
    }
    return { headers, rows: items.map(item => headers.map(header => item[header])) };
  }

  const arrayRows = items.every(Array.isArray);
  if (arrayRows) {
    const width = maxRowWidth(items);
    return {
      headers: Array.from({ length: width }, (_, index) => `column_${index + 1}`),
      rows: items
    };
  }

  return { headers: ['value'], rows: items.map(item => [item]) };
}

function escapeDelimited(value, delimiter) {
  const text = scalarValue(value);
  if (text.includes('"') || text.includes('\r') || text.includes('\n') || text.includes(delimiter)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function serializeDelimited(items, delimiter) {
  const table = tableShape(items);
  const lines = [table.headers.map(value => escapeDelimited(value, delimiter)).join(delimiter)];
  for (const row of table.rows) lines.push(row.map(value => escapeDelimited(value, delimiter)).join(delimiter));
  return lines.join('\n');
}

function serializeTarget(items, target, options) {
  if (target === 'json') {
    const indent = options.jsonIndent === 0 ? 0 : Math.max(0, Math.min(8, Number(options.jsonIndent) || 2));
    return `${JSON.stringify(items, null, indent)}\n`;
  }
  if (target === 'ndjson') return items.map(item => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
  if (target === 'csv') return serializeDelimited(items, ',');
  if (target === 'tsv') return serializeDelimited(items, '\t');
  throw new Error('Unknown structured-data output format.');
}

async function convertTable(record, options = {}) {
  const source = sourceFormat(record);
  const target = FORMATS[options.format] || FORMATS.json;
  const items = await parseSource(record, options);
  const text = serializeTarget(items, target.value, options);
  const blob = new Blob([text], { type: `${target.mime};charset=utf-8` });
  return {
    blob,
    name: outputName(record, target.extension, {
      forceSuffix: source === target.value,
      suffix: 'converted'
    }),
    summary: `${target.label} · ${items.length} row${items.length === 1 ? '' : 's'}`,
    details: { rows: items.length, source, target: target.value },
    warnings: []
  };
}

export const tableConverter = {
  id: 'table',
  label: 'Structured data',
  matches(record) {
    return sourceFormat(record) !== null;
  },
  targets() {
    return Object.values(FORMATS).map(({ value, label, description }) => ({ value, label, description }));
  },
  suggestedTarget(record) {
    const source = sourceFormat(record);
    if (source === 'json' || source === 'ndjson') return 'csv';
    return 'json';
  },
  inspect(record) {
    return Promise.resolve({ kind: 'table', sourceFormat: sourceFormat(record) });
  },
  convert: convertTable
};
