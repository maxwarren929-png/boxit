# BoxIt

BoxIt is a browser extension for disposable and reusable file boxes.

Instead of keeping temporary upload files scattered through Downloads, BoxIt stores them inside named boxes in the browser. You can capture or drop something into a box, convert it locally, keep it there, download it later, or use it directly as the source for a website upload.

## MVP

- Create, rename, and delete named boxes
- Import local files with drag and drop or a file picker
- Store file blobs locally in IndexedDB
- Browse, rename, preview, download, and delete files by box
- Search across box names, filenames, and file types
- Sort boxes/files by default order, recency, name, or size
- Show exact BoxIt storage usage and browser quota usage when available
- Detect exact duplicate files and remove redundant copies deliberately
- Use stored files on website upload controls, including hidden/custom inputs
- Choose between multiple upload targets on a page
- Paste clipboard images directly into a box
- Capture the visible tab as a PNG directly into a box
- Drop webpage image/file URLs into a box for local capture
- Right-click images or links and save them to the current capture-default box
- Automatically create a `Captured` box when a right-click capture has no chosen destination
- Convert supported files locally without uploading them to a conversion service
- Give boxes automatic lifetimes, session cleanup, or one-shot deletion

## Quality of life

The popup includes a global search field and visual sort control. `Ctrl/Cmd+K` or `/` focuses search without touching the current box/file order stored in IndexedDB.

Rename controls are available for both boxes and files. Supported files can be previewed locally:

- images
- text/code/data files, with large text previews truncated
- PDFs
- audio
- video

The storage line shows the exact total size of BoxIt file blobs plus browser quota usage when the browser exposes it.

Duplicate detection is exact rather than filename-based. BoxIt only hashes same-size candidates within the same box, using SHA-256, and marks byte-for-byte matches. The cleanup action keeps the oldest copy and only removes extras after confirmation. Automatic hashing is capped at 64 MB per candidate so opening the popup does not try to digest very large files. Empty files are supported as duplicates too.

## Quick capture

Each box has three quick-capture controls:

- **Paste image** reads image data from the clipboard and stores it locally.
- **Screenshot** captures the visible area of the active tab and stores it as a PNG.
- **Capture here** makes that box the destination for future right-click captures.

The page drop zone also accepts local files and supported webpage image/file URLs. Right-click capture uses a page-context fallback for resources such as `blob:` images when a normal extension fetch is not enough.

## File conversion

Supported files get a **Convert** action in their file row. Conversion always creates a new local file in the same box and leaves the original untouched.

Current converters:

- PNG, JPEG, WebP, SVG, BMP, and AVIF images to PNG, JPEG, or WebP
- Optional image downscaling with aspect ratio preserved and no upscaling
- JPEG/WebP quality control
- JSON arrays to CSV
- CSV tables to formatted JSON

Image conversion is performed with browser canvas APIs and data conversion is handled directly in the extension. No conversion website or remote API is used.

Conversion guardrails:

- Image outputs are bounded to 16,384 pixels per side and 80 million output pixels
- JSON/CSV conversion is limited to 20 MB in the current MVP
- Animated GIF conversion is intentionally not included yet because flattening an animation into one frame would be misleading
- PDF, DOCX, video, audio, archive, and other complex formats are not claimed as supported until BoxIt has a reliable local converter for them

## Temporary boxes

Every box can keep the default permanent lifetime or clean itself up automatically.

Lifetime modes:

- **Keep forever** leaves the box alone until you delete it.
- **Delete after a duration** accepts a custom number of minutes, hours, or days. Chrome alarms enforce the expiry even while the popup is closed.
- **Delete when browser restarts** keeps the box for the current browser session and removes it on the next browser launch.
- **Delete after first successful Use** can be enabled alongside any lifetime mode. The entire box is deleted only after BoxIt confirms a stored file was successfully placed into a website upload control. Failed Uses do not trigger deletion.

Existing boxes have a **Lifetime** control, and temporary boxes display a compact remaining-time/session/one-shot label in the popup.

## Privacy

BoxIt is local-first. Stored file contents live in the browser's IndexedDB. Clipboard images and screenshots are captured only after an explicit user action. Right-click and webpage captures fetch the item you selected so it can be stored locally. File conversion, previews, search, sorting, storage totals, and duplicate hashing happen inside the extension. Files leave BoxIt only when you explicitly use or download them.

## Next direction

The MVP feature set is now broad enough that the next priority should be a real-browser test and cleanup pass before adding another major feature. After that, likely directions are a side-panel workflow, broader local conversion support, or import/export of whole boxes.
