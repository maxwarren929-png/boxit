# BoxIt

BoxIt is a browser extension for disposable and reusable file boxes.

Instead of keeping temporary upload files scattered through Downloads, BoxIt stores them inside named boxes in the browser. You can drop a file into a box, keep it there, download it again later, or use it as the source for a website file upload.

## MVP

- Create and delete boxes
- Import files with drag and drop or a file picker
- Store file blobs locally in IndexedDB
- Browse files by box
- Download or delete stored files
- Inject a stored file into compatible `<input type="file">` elements

## Direction

Later versions can add local file conversion, automatic expiry rules, clipboard/screenshot capture, temporary one-shot boxes, search, and optional sync for metadata.

## Privacy

The MVP is local-first. File contents stay in the browser unless you explicitly upload or download them.
