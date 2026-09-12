# BoxIt

BoxIt is a browser extension for disposable and reusable file boxes.

Instead of keeping temporary upload files scattered through Downloads, BoxIt stores them inside named boxes in the browser. You can capture or drop something into a box, convert it locally, keep it there, download it later, or use it directly as the source for a website upload.

## MVP

- Create, rename, and delete named boxes
- Import local files with drag and drop or a file picker
- Store file blobs locally in IndexedDB
- Browse, rename, preview, download, and delete files by box
- Search and sort boxes/files
- Show local storage usage
- Detect exact duplicate files and remove redundant copies deliberately
- Use stored files on website upload controls
- Paste clipboard images and capture screenshots
- Right-click images or links into BoxIt
- Convert supported files locally
- Give boxes timed, session, or one-shot lifetimes
- Automate new files with local rules

## Quality of life

The popup includes global search and visual sorting. `Ctrl/Cmd+K` or `/` focuses search.

Supported local previews include images, text/code/data files, PDFs, audio, and video. Duplicate detection hashes same-size candidates in the same box with SHA-256. Automatic duplicate hashing is deferred until idle time and skips uncached candidates larger than 8 MB.

## Quick capture

Each box can paste clipboard images, capture the visible tab as PNG, and become the destination for future right-click captures. The drop zone also accepts local files and supported webpage image/file URLs.

## Rules

The **Rules** manager lets BoxIt react to new imported, captured, or converted files. Rules are non-retroactive: creating a rule never reorganizes files that were already in BoxIt before the rule existed.

Rules can match by box, file category, extension, filename text, capture website, and file size. A matching rule can move the file, rename it from a template, give the individual file an expiry, reject a byte-for-byte duplicate, or automatically create a converted image/data copy.

Automatic image rules support PNG/JPEG/WebP outputs. Structured-data rules support JSON/CSV/TSV/NDJSON outputs. Conversion chains carry a rule trace and have a depth limit so two rules cannot convert files forever. Rule activity is logged locally in the Rules manager.

Individual rule-based file expiry is separate from box lifetime. BoxIt tracks the next due file with one Chrome alarm rather than creating an alarm for every temporary file.

See `RULES.md` for the complete rule model and limits.

## Conversion engine v2

Supported files get a **Convert** action. Conversion always creates a new local file in the same box and leaves the original untouched.

The converter is registry-based: image, structured-data, document, and media conversion are separate adapters behind one engine. New converter families can be added without growing one large format switch.

### Images

Inputs currently recognized:

- PNG
- JPEG
- WebP
- SVG
- BMP
- AVIF

Outputs:

- PNG
- JPEG
- WebP
- BMP

Image options:

- fit within maximum width/height while preserving aspect ratio
- exact width/height mode
- 0°, 90°, 180°, or 270° rotation
- JPEG/WebP quality control
- background color when flattening transparency to JPEG or BMP
- automatic metadata stripping because output pixels are redrawn locally

Image output is bounded to 16,384 pixels per side and 80 million pixels. BMP has a stricter 25 million-pixel limit because its uncompressed output is much heavier.

### Structured data

BoxIt uses one shared structured-data model for:

- JSON
- NDJSON / JSONL
- CSV
- TSV

Any recognized structured-data input can convert to any of those four outputs. CSV/TSV can be treated as headerless tables, JSON can be pretty-printed or compacted, quoted fields are parsed correctly, duplicate/blank headers are normalized, and nested values are JSON-stringified when a flat table format cannot represent them directly.

Structured-data conversion is limited to 20 MB per file in the current browser-popup implementation.

### Documents

Recognized document inputs:

- DOCX
- TXT
- Markdown
- HTML

Outputs:

- plain text
- Markdown
- HTML

DOCX files are parsed locally as OOXML. BoxIt reads `word/document.xml` from the DOCX ZIP container, including DEFLATE-compressed entries, and preserves basic document structure such as headings, paragraphs, lists, and tables. Embedded images, comments, footnotes, equations, headers/footers, and advanced Word layout are intentionally not copied into these text-oriented outputs.

DOCX source files are limited to 50 MB, with a 32 MB expanded limit for individual document entries. Text/Markdown/HTML conversion keeps the existing 20 MB text limit.

### Media

Audio inputs recognized by extension/MIME include common browser-decodable MP3, WAV, M4A/AAC, OGG/Opus, and FLAC files. Audio can be decoded locally and written as 16-bit PCM WAV, with an optional mono mixdown.

Video inputs recognized by extension/MIME include MP4, WebM, MOV/M4V, and OGV. BoxIt does not transcode the whole video yet; it extracts a still frame at a chosen timestamp as PNG or JPEG, with JPEG quality control.

Media conversion uses codecs already available in Chromium. If Chromium cannot decode a codec, BoxIt fails locally instead of uploading the file anywhere. Media source files are capped at 250 MB, WAV output is capped at 250 MB, and extracted video frames are bounded to 8,192 pixels per side / 30 million pixels.

### Conversion result feedback

BoxIt reports the output format, row/block count or image/frame dimensions, and whether the converted copy is smaller or larger than the original.

PDF conversion and full audio/video transcoding are still intentionally unsupported. Those need heavier local adapters such as PDF rendering/parsing and a worker/WASM media pipeline rather than pretending browser-native APIs can do them reliably.

## Temporary boxes

Lifetime modes:

- **Keep forever**
- **Delete after a duration**
- **Delete when browser restarts**
- **Delete after first successful Use**

Timed expiry uses Chrome alarms. One-shot boxes require explicit cleanup after a file is placed into a website so BoxIt does not delete local data before the user can verify the site actually accepted it.

## Privacy

BoxIt is local-first. Stored file contents live in IndexedDB. Clipboard capture, screenshots, conversion, rules, previews, search, sorting, storage totals, and duplicate hashing run locally. Files leave BoxIt only when you explicitly use or download them.

## Next direction

Likely next steps are box import/export, PDF conversion, reusable conversion presets, and a worker/WASM adapter for true audio/video transcoding.
