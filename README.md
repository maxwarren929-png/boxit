# BoxIt

BoxIt is a browser extension for disposable and reusable file boxes.

Instead of keeping temporary upload files scattered through Downloads, BoxIt stores them inside named boxes in the browser. You can capture or drop something into a box, convert it locally, keep it there, download it later, or use it directly as the source for a website upload.

## MVP

- Create and delete named boxes
- Import local files with drag and drop or a file picker
- Store file blobs locally in IndexedDB
- Browse, download, and delete files by box
- Use stored files on website upload controls, including hidden/custom inputs
- Choose between multiple upload targets on a page
- Paste clipboard images directly into a box
- Capture the visible tab as a PNG directly into a box
- Drop webpage image/file URLs into a box for local capture
- Right-click images or links and save them to the current capture-default box
- Automatically create a `Captured` box when a right-click capture has no chosen destination
- Convert supported files locally without uploading them to a conversion service

## Quick capture

Each box has three quick-capture controls:

- **Paste image** reads image data from the clipboard and stores it locally.
- **Screenshot** captures the visible area of the active tab and stores it as a PNG.
- **Capture here** makes that box the destination for future right-click captures.

The page drop zone also accepts local files and supported webpage image/file URLs. Right-click capture uses a page-context fallback for resources such as `blob:` images when a normal extension fetch is not enough.

## File conversion

Supported files get a **Convert** action in their file row. Conversion always creates a new file in the same box and leaves the original untouched.

Current converters:

- Images to PNG, JPEG, or WebP
- Optional image downscaling with aspect ratio preserved
- JPEG/WebP quality control
- JSON arrays to CSV
- CSV tables to formatted JSON

Image conversion is performed with browser canvas APIs and data conversion is handled directly in the extension. No conversion website or remote API is used.

## Privacy

BoxIt is local-first. Stored file contents live in the browser's IndexedDB. Clipboard images and screenshots are captured only after an explicit user action. Right-click and webpage captures fetch the item you selected so it can be stored locally. File conversion happens inside the extension. Files leave BoxIt only when you explicitly use or download them.

## Next direction

Planned follow-up work includes automatic expiry and one-shot boxes, search, previews, storage management, and broader conversion support where it can be done safely and reliably in-browser.
