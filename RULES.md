# BoxIt Rules

Rules make BoxIt react to files as they enter the browser filesystem. Rules are deliberately non-retroactive: a rule only applies to files created after that rule was created, so adding a new rule cannot unexpectedly reorganize old boxes.

A rule has one trigger, zero or more conditions, and one or more actions. Every filled condition must match. Matching rules run in creation order unless a rule has **Stop after this rule** enabled.

## Triggers

- **Any new file** — captured, imported, or converted.
- **Added/imported** — normal local files and drag/drop imports.
- **Captured** — clipboard images, screenshots, webpage drops, and right-click captures.
- **Converted** — manual BoxIt conversions and copies created by automatic conversion rules.

## Conditions

Rules can match by source box, file category, one or more extensions, filename text, website host, and minimum/maximum file size.

Website matching uses a capture's source/page URL when BoxIt knows it. A host condition such as `github.com` therefore matches GitHub captures without accidentally treating an unrelated local import as a GitHub file just because that tab was open.

## Actions

- **Move to box** changes the file's destination without making another copy.
- **Rename template** supports `{name}`, `{base}`, `{ext}`, `{date}`, `{time}`, `{source}`, and `{host}`.
- **Expire after** sets an individual file lifetime without changing its box lifetime.
- **Reject exact duplicates** SHA-256 hashes same-size candidates and deletes only the newly-added byte-for-byte duplicate. Automatic duplicate rule hashing is capped at 64 MB per file.
- **Auto-convert** supports common raster images to PNG/JPEG/WebP and structured data to JSON/CSV/TSV/NDJSON. Unsupported source/target combinations are skipped and logged.

Generated conversion files carry a rule trace. A rule will not run twice in the same conversion chain, and automatic chains stop after a small depth limit, preventing conversion loops. If the source file already has a rule-set expiry, its automatic converted copy inherits that expiry.

## Execution

The background service worker scans pending files immediately when the popup is open and at least once a minute otherwise. Right-click and remote captures schedule a near-immediate scan. Individual file expiries share one next-expiry alarm rather than allocating one Chrome alarm per file.

Rule activity is recorded locally and shown in the Rules manager. Rules and logs are stored in `chrome.storage.local`; file blobs remain in IndexedDB.
