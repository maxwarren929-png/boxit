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

## Quality of life

The popup includes global search and visual sorting. `Ctrl/Cmd+K` or `/` focuses search.

Supported local previews include images, text/code/data files, PDFs, audio, and video. Duplicate detection hashes same-size candidates in the same box with SHA-256. Automatic duplicate hashing is deferred until idle time and skips uncached candidates larger than 8 MB.

## Quick capture

Each box can paste clipboard images, capture the visible tab as PNG, and become the destination for future right-click captures. The drop zone also accepts local files and supported webpage image/file URLs.

## Conversion engine v2

Supported files get a **Convert** action. Conversion always creates a new local file in the same box and leaves the original untouched.

The converter is registry-based: image and structured-data conversion are separate adapters behind one engine. New converter families can be added without growing one large format switch.

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

Image output is bounded to 16,384 pixels per side and 80 million pixels.

### Structured data

BoxIt now uses one shared structured-data model for:

- JSON
- NDJSON / JSONL
- CSV
- TSV

Any recognized structured-data input can convert to any of those four outputs. CSV/TSV can be treated as headerless tables, JSON can be pretty-printed or compacted, quoted fields are parsed correctly, duplicate/blank headers are normalized, and nested values are JSON-stringified when a flat table format cannot represent them directly.

Structured-data conversion is limited to 20 MB per file in the current browser-popup implementation.

### Conversion result feedback

BoxIt reports the output format, row count or image dimensions, and whether the converted copy is smaller or larger than the original.

Complex formats such as PDF, DOCX, video, audio, and archives are still intentionally unsupported until they have reliable local adapters.

## Temporary boxes

Lifetime modes:

- **Keep forever**
- **Delete after a duration**
- **Delete when browser restarts**
- **Delete after first successful Use**

Timed expiry uses Chrome alarms. One-shot boxes require explicit cleanup after a file is placed into a website so BoxIt does not delete local data before the user can verify the site actually accepted it.

## Privacy

BoxIt is local-first. Stored file contents live in IndexedDB. Clipboard capture, screenshots, conversion, previews, search, sorting, storage totals, and duplicate hashing run locally. Files leave BoxIt only when you explicitly use or download them.

## Next direction

The next major architecture candidates are a persistent side-panel workflow, box import/export, and additional local converter adapters for document or media formats.
