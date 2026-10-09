# Authorized HTML Import

For automatic processing of exported pairs, see [browser export inbox](watch-exports.md).

This core edition imports authorized snapshots; it does not contain a browser
extension or read the normal browser's cookies/profile. For publicly accessible
HTML, the HTTP or dedicated-browser route needs no extension. To reuse access
from an already logged-in tab, the existing full-project exporter remains an
optional, separately installed component. A minimal exporter is not included yet.

Keep the original downloaded HTML and its matching `.html.json` together:

```sh
node scripts/save-paper.mjs "10.1038/s41592-025-02899-6" --html "exports/paper.html"
node scripts/clip.mjs "exports"
```

No article request is made by import. `--download-assets` explicitly permits
public image downloads. Title resolution still uses Crossref; use a DOI/URL when
offline. The extension's images are URLs, not embedded binaries.

The sidecar records schemaVersion (1), captureMethod (clipper-dom), extensionVersion,
sourceUrl, url, baseURI, title, capturedAt, charset, htmlFile, htmlBytes and status
(unchecked). The importer validates the pair rather than trusting its filename.
Use genuine exports; do not fabricate metadata to bypass input validation.

The exporter snapshots the rendered top-level publisher DOM. It does not unlock
subscription content or capture unloaded sections, nested frames or PDF viewers.
Its cleanup disables executable content but does not guarantee that all personal
data is removed. Keep exports private and inspect before sharing. A page that
only shows a subscription preview will still be rejected by content checks.
