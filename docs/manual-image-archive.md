# Manual Markdown And Image ZIP

To save the same local images directly into a translation-ready directory,
configure [Default Paper Directory](default-paper-directory.md). ZIP remains
an independent option without directory authorization.

Reload the updated extension, open a paper, and open Paper Clipper. Review or
edit the note, then use the arrow next to **Add to Obsidian** and choose
**Download Markdown + images ZIP**. Keep the popup or sidebar open until the
download starts. No local service, pairing key or Vault permission is needed.

Extract the ZIP into your Vault. Keep its enclosing `paper-<unique-id>` folder:
it contains `paper.md`, `checks.json` and an `images/` directory. The unique folder prevents
attachment collisions between papers. Rename the note if desired, keeping it
next to `images/`. Extraction itself is performed by you, not by the extension.

This command archives the **current editor contents**, not a newly fetched
article. It preserves frontmatter, prose and captions, downloads inline and
reference-style Markdown images, and rewrites their displayed references to
relative local paths. Repeated URLs are downloaded once. Unused reference
definitions, ordinary hyperlinks and frontmatter values remain unchanged.
It does not prove article completeness or replace the Core's DOI, preservation
and Vault checks. Existing Add to Obsidian and plain Markdown downloads are
unchanged and still retain remote images.

## Image resolution

Local image downloads now prefer the verified `/full/` variant of Nature's
Springer Nature CDN thumbnails. For Cell, the exporter uses the current page's
explicit `data-viewer-src` large-image address, including its actual asset ID;
it does not guess an ID or filename. Both ZIP and default-directory saves use
the same selection rules. Other publishers keep their existing image addresses.

When a preferred source fails, is not a supported image, or exceeds the byte
limit, the downloader tries the original address once. If that also fails, the
existing failure behavior applies. Where an upgrade was attempted, the bundle
includes `image-report.json` beside `paper.md`: each image records `preferred`,
`original-fallback`, or `original`. This records source selection, not a universal
pixel-size or visual-quality guarantee. No image resampling or AI upscaling occurs.
Signed URLs are kept intact; unfamiliar Nature query parameters are not rewritten.
No cookies or browser permissions are added. Existing paper/translation folders
are not upgraded in place; reload the extension and re-export into a new folder.

Nature Extended Data figure links are also embedded as images when the article
declares their image URL in `data-supp-info-image`. This includes the known
Springer Nature `/esm/` image route and uses the same full-size/fallback rules.
The exporter does not crawl figure-viewer pages or invent missing image URLs.

Novae Figure 1 was checked locally: the thumbnail is 685 x 395 pixels, versus
2169 x 1251 for the full-size PNG. Cell large-image URLs were verified against
the supplied HTML, but unauthenticated requests returned 403 in the local test
environment; actual availability there still depends on the publisher/browser.

## Captions and references

On supported Cell pages, full figure captions already present inside a collapsed
caption panel are retained without clicking **Show full caption**. Only the
identified caption content is preserved, not unrelated hidden panels. Cell
bibliography entries are emitted as complete rich-text footnote definitions,
including authors, title, journal and available links; inline citation previews
are still removed from the body. These rules are shared by manual clipping,
HTML imports and the API/CLI conversion paths.

Content absent from the captured HTML cannot be recovered by these rules. Reload
the extension and refresh the paper before exporting again. Existing notes and
translations are not repaired or overwritten automatically.

## Export checks

ZIP and default-directory saves now include the same `checks.json`, bound by
SHA-256 to the final `paper.md` after localizing images. Checks run locally with
no additional network requests. The source is the capture that populated the
editor, not a fresh extraction at save time. Image hints and DOI metadata also
come from that capture. The top-level save-page handoff carries only the compact
report and an input hash, not an additional copy of publisher HTML.

The report distinguishes three stages: `extraction` (before selections/highlights
and templates), `template` (the initial editor content), and `output` (the content
being saved). Changed templates, selections, highlights, AI processing or editor
changes are recorded without guessing whether an omission was intentional.
Text is never repaired or restored automatically.

Implemented scopes are Cell/Nature main caption paragraphs, order and links;
Cell full bibliography text/links and per-reference inline citation counts;
Nature explicitly declared Extended Data image URLs under their headings; and
the existing MathJax formula-preservation check. Numeric footnotes use the
converter's paragraph/indented-continuation format. This does not verify citation
semantics, every alternative Markdown dialect, extended captions, all ordinary
paragraphs, tables, non-MathJax equations, or content absent from the capture.

- `completeness` remains `not-assessed`: these checks cannot prove full-text access.
- `preservation` is `passed-within-scope`, `attention-required`, or `not-assessed`.
  A failure at any stage remains visible even if later editing restores it.
- `coverage` is `partial-source` when supported checks ran, otherwise `not-assessed`.
  Individual unavailable/unsupported checks say `not-covered`, never "complete".
- Image download checks are separate and record original-resolution fallbacks.
  Response type/signature checks are not image decoding or visual-quality checks.

Content differences produce a visible review warning while retaining the edited
note and report. Unknown publishers are not rejected solely for missing coverage.
Existing formula-extraction and image-download failure gates are unchanged;
image failure still prevents publishing a ZIP or creating a paper directory.
Plain Markdown downloads and Add to Obsidian do not generate this report.

Synthetic tests cover missing captions, reference text/links/counts, formulas and
extended images, edited/custom-template outputs, absent coverage, stale report
binding, ZIP/file consistency and save-page handoff. A read-only local replay on
2026-10-15 matched Cell's 5 captions, 112 references and 29 formulas, plus DeepMet's
5 main captions and 10 extended images. Private captures are not CI fixtures and
were not modified; these counts do not establish universal publisher coverage.

## Limits

- PNG, JPEG, GIF, WebP and AVIF with matching response type and file signature.
- Maximum 200 distinct images, 20 MiB per response, 100 MiB saved image data,
  5 MiB Markdown characters, and 15 seconds per candidate request (at most two
  candidates per image).
- HTTP(S) public hostname URLs only. No embedded URL credentials, literal IP
  addresses, local hostnames, data/blob/file URLs, SVG, HTML media or Obsidian
  wiki embeds. Such media produces an explicit error instead of a partial ZIP.
- Downloads omit cookies and referrer, and reject redirects. Signed URLs are
  used intact. Authentication-dependent, expired, redirecting or blocked image
  requests may fail even when the webpage can display the image. Browser
  network protections apply; this route does not perform Core's DNS pinning.
- Any detected image failure aborts the ZIP. The editor and existing Vault
  remain unchanged; the error does not print signed URLs or credentials.
- No private publisher captures are included in tests. Synthetic Chromium
  coverage does not establish compatibility with every publisher or browser.
