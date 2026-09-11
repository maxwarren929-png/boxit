# BoxIt

BoxIt is a browser extension for disposable and reusable file boxes.

Instead of keeping temporary upload files scattered through Downloads, BoxIt stores them inside named boxes in the browser. You can capture or drop something into a box, keep it there, download it later, or use it directly as the source for a website upload.

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

## Quick capture

Each box has three quick-capture controls:

- **Paste image** reads image data from the clipboard and stores it locally.
- **Screenshot** captures the visible area of the active tab and stores it as a PNG.
- **Capture here** makes that box the destination for future right-click captures.

The page drop zone also accepts local files and supported webpage image/file URLs. Right-click capture uses a page-context fallback for resources such as `blob:` images when a normal extension fetch is not enough.

## Privacy

BoxIt is local-first. Stored file contents live in the browser's IndexedDB. Clipboard images and screenshots are captured only after an explicit user action. Right-click and webpage captures fetch the item you selected so it can be stored locally. Files leave BoxIt only when you explicitly use or download them.

## Next direction

Planned follow-up work includes local file conversion, automatic expiry and one-shot boxes, search, previews, and storage management.
