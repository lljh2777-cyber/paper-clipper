# Archive Library

Open **Archives** from the extension toolbar or Settings. The page reuses the
default paper directory handle when available, checking **read** permission only.
It never requests write access. **Authorize reading** is an explicit action if
permission has expired. **Choose directory** grants read access to another root
for the current tab only; it does not replace the saved default or persist an
archive index. Refresh or reopen to see external changes.

Search title, DOI (including doi.org URLs), publication year or folder name.
Sort by archive date, title or year. Each result shows the folder path relative
to the selected root, DOI and recorded archive/translation states. Results are
shown 50 at a time. This page does not launch local files or a native file manager.

Only immediate child `translation.json` files are read, at most 128 KiB each,
using schema 1 and `sourceFile: paper.md`. Notes, translations, images and nested
folders are not opened. No archive files are written, repaired, moved or deleted.
Unpacked standardized ZIP bundles can be listed; ZIP files and metadata-free
notes are not indexed. Missing metadata is counted, invalid/unreadable or
unsupported metadata is listed separately. After 5,000 root entries, scanning
stops and explicitly marks the result partial. Permission failures clear results.

All displayed states are metadata records, not a fresh check of file existence,
translation progress, quality or full-text completeness. Editing a translation
outside the tool will not automatically update its recorded status. Repeated DOI
versions remain separate entries. No article contents or directory metadata are
sent to a server or saved in browser history/search indexes.

Unit tests cover read-only calls, missing/corrupt/oversized metadata, permission
denial/revocation, search/sort, enumeration bounds and safe text rendering.
Hosted Chromium tests use synthetic OPFS files, guard against writes and reads
of notes, verify unchanged bytes, and capture desktop/mobile screenshots. Native
folder-picker consent and browser restart permission behavior still need manual
acceptance; no personal archive is used by these tests.
