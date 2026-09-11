import { extensionOf, outputName, MAX_TEXT_CONVERSION_BYTES } from './conversion-utils.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_TYPES = new Map([
  ['txt', { mime: 'text/plain;charset=utf-8', label: 'Plain text' }],
  ['md', { mime: 'text/markdown;charset=utf-8', label: 'Markdown' }],
  ['html', { mime: 'text/html;charset=utf-8', label: 'HTML' }]
]);
const MAX_DOCX_BYTES = 50 * 1024 * 1024;
const MAX_DOCX_ENTRY_BYTES = 32 * 1024 * 1024;

function sourceFormat(record) {
  const ext = extensionOf(record?.name);
  const type = String(record?.type || '').toLowerCase();
  if (ext === 'docx' || type === DOCX_MIME) return 'docx';
  if (['md', 'markdown'].includes(ext) || type === 'text/markdown') return 'md';
  if (['html', 'htm'].includes(ext) || type === 'text/html') return 'html';
  if (ext === 'txt' || type === 'text/plain') return 'txt';
  return null;
}

function localName(node) {
  return String(node?.localName || node?.nodeName || '').replace(/^.*:/, '').toLowerCase();
}

function attr(node, name) {
  return node?.getAttribute?.(`w:${name}`) || node?.getAttribute?.(name) || '';
}

function descendants(node, name) {
  const out = [];
  const target = String(name).toLowerCase();
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
  let current = walker.currentNode;
  while (current) {
    if (localName(current) === target) out.push(current);
    current = walker.nextNode();
  }
  return out;
}

function textFromWordNode(node) {
  let text = '';
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let current = walker.currentNode;
  while (current) {
    if (current.nodeType === Node.TEXT_NODE && localName(current.parentElement) === 't') text += current.nodeValue || '';
    else if (current.nodeType === Node.ELEMENT_NODE && localName(current) === 'tab') text += '\t';
    else if (current.nodeType === Node.ELEMENT_NODE && localName(current) === 'br') text += '\n';
    current = walker.nextNode();
  }
  return text.replace(/\u00a0/g, ' ').trim();
}

function paragraphBlock(node) {
  const text = textFromWordNode(node);
  if (!text) return null;
  const pStyle = descendants(node, 'pstyle')[0];
  const style = attr(pStyle, 'val');
  const headingMatch = style.match(/heading\s*([1-6])/i);
  if (headingMatch) return { type: 'heading', level: Number(headingMatch[1]), text };
  if (/^title$/i.test(style)) return { type: 'heading', level: 1, text };
  if (descendants(node, 'numpr').length) return { type: 'list', text };
  return { type: 'paragraph', text };
}

function tableBlock(node) {
  const rows = [];
  for (const rowNode of descendants(node, 'tr')) {
    const cells = [];
    for (const cellNode of [...rowNode.children].filter(child => localName(child) === 'tc')) {
      const parts = [];
      for (const paragraph of descendants(cellNode, 'p')) {
        const text = textFromWordNode(paragraph);
        if (text) parts.push(text);
      }
      cells.push(parts.join(' '));
    }
    if (cells.length) rows.push(cells);
  }
  return rows.length ? { type: 'table', rows } : null;
}

function findEndOfCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = Math.max(0, bytes.byteLength - 65557);
  for (let offset = bytes.byteLength - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error('This DOCX file has an invalid ZIP directory.');
}

function zipDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes);
  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const entries = new Map();
  let offset = centralOffset;
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('This DOCX file has a damaged ZIP directory.');
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { flags, compression, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function unzipEntry(bytes, entry) {
  if (entry.flags & 0x1) throw new Error('Encrypted DOCX files are not supported.');
  if (entry.uncompressedSize > MAX_DOCX_ENTRY_BYTES) throw new Error('This DOCX contains an unusually large document entry.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.localOffset, true) !== 0x04034b50) throw new Error('This DOCX has an invalid ZIP entry.');
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = bytes.slice(dataStart, dataStart + entry.compressedSize);
  if (entry.compression === 0) return compressed;
  if (entry.compression !== 8) throw new Error('This DOCX uses an unsupported ZIP compression method.');
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress DOCX files locally.');
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const output = new Uint8Array(await new Response(stream).arrayBuffer());
  if (output.byteLength > MAX_DOCX_ENTRY_BYTES) throw new Error('This DOCX expands beyond BoxIt\'s document limit.');
  return output;
}

async function docxBlocks(record) {
  if (Number(record.size || 0) > MAX_DOCX_BYTES) throw new Error('DOCX conversion is limited to 50 MB.');
  const bytes = new Uint8Array(await record.blob.arrayBuffer());
  const entries = zipDirectory(bytes);
  const documentEntry = entries.get('word/document.xml');
  if (!documentEntry) throw new Error('This DOCX does not contain word/document.xml.');
  const xmlBytes = await unzipEntry(bytes, documentEntry);
  const xml = new DOMParser().parseFromString(new TextDecoder().decode(xmlBytes), 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('This DOCX contains invalid document XML.');
  const body = [...xml.getElementsByTagName('*')].find(node => localName(node) === 'body');
  if (!body) throw new Error('This DOCX has no document body.');
  const blocks = [];
  for (const child of body.children) {
    const kind = localName(child);
    const block = kind === 'p' ? paragraphBlock(child) : kind === 'tbl' ? tableBlock(child) : null;
    if (block) blocks.push(block);
  }
  return blocks;
}

function plainTextBlocks(text) {
  return String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/).map(part => part.trim()).filter(Boolean).map(text => ({ type: 'paragraph', text }));
}

function markdownBlocks(text) {
  const blocks = [];
  for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
    else if (/^[-*+]\s+/.test(line)) blocks.push({ type: 'list', text: line.replace(/^[-*+]\s+/, '') });
    else blocks.push({ type: 'paragraph', text: line });
  }
  return blocks;
}

function htmlBlocks(text) {
  const doc = new DOMParser().parseFromString(String(text), 'text/html');
  const blocks = [];
  const visit = node => {
    const tag = String(node.tagName || '').toLowerCase();
    if (/^h[1-6]$/.test(tag)) blocks.push({ type: 'heading', level: Number(tag.slice(1)), text: node.textContent.trim() });
    else if (tag === 'p') blocks.push({ type: 'paragraph', text: node.textContent.trim() });
    else if (tag === 'li') blocks.push({ type: 'list', text: node.textContent.trim() });
    else if (tag === 'table') {
      const rows = [...node.querySelectorAll('tr')].map(row => [...row.querySelectorAll(':scope > th, :scope > td')].map(cell => cell.textContent.trim()));
      if (rows.length) blocks.push({ type: 'table', rows });
      return;
    }
    for (const child of node.children || []) visit(child);
  };
  visit(doc.body);
  return blocks.filter(block => block.type === 'table' || block.text);
}

async function sourceBlocks(record, format) {
  if (format === 'docx') return docxBlocks(record);
  if (Number(record.size || 0) > MAX_TEXT_CONVERSION_BYTES) throw new Error('Text document conversion is limited to 20 MB.');
  const text = await record.blob.text();
  if (format === 'html') return htmlBlocks(text);
  if (format === 'md') return markdownBlocks(text);
  return plainTextBlocks(text);
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeMarkdownCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function serializeText(blocks) {
  return blocks.map(block => {
    if (block.type === 'list') return `- ${block.text}`;
    if (block.type === 'table') return block.rows.map(row => row.join('\t')).join('\n');
    return block.text;
  }).join('\n\n').trim() + '\n';
}

function serializeMarkdown(blocks) {
  return blocks.map(block => {
    if (block.type === 'heading') return `${'#'.repeat(Math.max(1, Math.min(6, block.level || 1)))} ${block.text}`;
    if (block.type === 'list') return `- ${block.text}`;
    if (block.type === 'table') {
      const width = Math.max(...block.rows.map(row => row.length));
      const rows = block.rows.map(row => Array.from({ length: width }, (_, i) => escapeMarkdownCell(row[i] ?? '')));
      if (!rows.length) return '';
      return [`| ${rows[0].join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(row => `| ${row.join(' | ')} |`)].join('\n');
    }
    return block.text;
  }).join('\n\n').trim() + '\n';
}

function serializeHtml(blocks) {
  const parts = ['<!doctype html>', '<meta charset="utf-8">', '<article>'];
  let listOpen = false;
  const closeList = () => { if (listOpen) { parts.push('</ul>'); listOpen = false; } };
  for (const block of blocks) {
    if (block.type === 'list') {
      if (!listOpen) { parts.push('<ul>'); listOpen = true; }
      parts.push(`<li>${escapeHtml(block.text)}</li>`);
      continue;
    }
    closeList();
    if (block.type === 'heading') {
      const level = Math.max(1, Math.min(6, block.level || 1));
      parts.push(`<h${level}>${escapeHtml(block.text)}</h${level}>`);
    } else if (block.type === 'table') {
      parts.push('<table>');
      block.rows.forEach((row, rowIndex) => {
        const cell = rowIndex === 0 ? 'th' : 'td';
        parts.push(`<tr>${row.map(value => `<${cell}>${escapeHtml(value)}</${cell}>`).join('')}</tr>`);
      });
      parts.push('</table>');
    } else {
      parts.push(`<p>${escapeHtml(block.text).replace(/\n/g, '<br>')}</p>`);
    }
  }
  closeList();
  parts.push('</article>');
  return parts.join('\n') + '\n';
}

function serialize(blocks, format) {
  if (format === 'html') return serializeHtml(blocks);
  if (format === 'md') return serializeMarkdown(blocks);
  return serializeText(blocks);
}

export const documentConverter = {
  id: 'document',
  label: 'Document',
  matches(record) { return sourceFormat(record) !== null; },
  targets(record) {
    const source = sourceFormat(record);
    return [...DOC_TYPES.entries()].map(([value, info]) => ({
      value,
      label: info.label,
      description: source === 'docx' ? `Extract DOCX content locally as ${info.label}. Embedded images are not carried over.` : `Normalize this document as ${info.label}.`
    }));
  },
  suggestedTarget(record) {
    const source = sourceFormat(record);
    if (source === 'docx' || source === 'html') return 'md';
    if (source === 'md') return 'html';
    return 'md';
  },
  async inspect(record) {
    const source = sourceFormat(record);
    return { kind: 'document', sourceFormat: source, textOnly: source === 'docx' };
  },
  async convert(record, options = {}) {
    const source = sourceFormat(record);
    const target = DOC_TYPES.get(options.format) ? options.format : 'txt';
    const blocks = await sourceBlocks(record, source);
    const output = serialize(blocks, target);
    const info = DOC_TYPES.get(target);
    return {
      blob: new Blob([output], { type: info.mime }),
      name: outputName(record, target),
      summary: `${info.label} · ${blocks.length} block${blocks.length === 1 ? '' : 's'}`
    };
  }
};
