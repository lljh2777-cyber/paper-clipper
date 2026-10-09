# Extension HTML export

For automatic processing of exported pairs, see [browser export inbox](watch-exports.md).

The **Export page HTML** button (file/download icon at the left of the header
tools) is available in the popup, side panel, and embedded clipper. In Simplified
Chinese its tooltip is **导出页面 HTML**. It takes a new snapshot at click time,
independently of the Markdown template, selected text, and extraction cache.

## Load the local Chrome build

From this repository:

```powershell
npm run build:chrome -- --env SKIP_CLEANUP=true
```

`SKIP_CLEANUP` disables the existing recursive `.DS_Store` cleanup hook. No files
need to be deleted to build or test this feature.

1. In the browser where the paper is already accessible, open `chrome://extensions`.
2. Enable Developer mode and choose **Load unpacked**.
3. Select `E:\Paper_Clipper\obsidian-clipper\dist` (not the repository root).
4. If that directory is already loaded, use its Reload button instead.
5. Refresh the paper and open the locally loaded Clipper.

The store-installed extension is not automatically updated by this build. If
both versions are installed, temporarily disable the store version to avoid
confusing the two. Do not uninstall it or erase its settings. The unpacked copy
has separate extension storage; HTML export does not require importing templates.
No new browser permissions are requested by this feature.

The 2026-10-08 local build also fixes missing long Nature figure legends in manual
clipping and Save Markdown, not just exported-HTML conversion. Reload this local
extension and refresh the article tab to clear the previous extraction. Novae's
six legends have been checked against its authorized saved HTML; see
[figure legend verification](paper-acceptance.md#nature-full-figure-legends).

## Export and convert Novae

1. In the existing authenticated browser, open
   <https://www.nature.com/articles/s41592-025-02899-6> and confirm the actual
   article sections, including Results and Methods, are loaded. Expand any content
   you need if the publisher loads it only after interaction.
2. Exit Clipper reader mode, open the Clipper popup or side panel, and click the
   header's **Export page HTML** icon. Prefer the side panel if download dialogs
   close the popup.
3. Keep the matching `.html` and `.html.json` downloads together. If the browser
   asks to allow multiple downloads, allow this pair and retry if one is missing.
   The UI reports that downloads were requested, not that both files were saved.
4. Import the download directory. The importer reads the captured URL from each
   JSON automatically, including institutional proxy URLs.

```powershell
npm run clip -- "E:\Paper_Clipper"
```

The command scans the top level, preserves the input pairs, and writes accepted
Markdown under `output/browser-fetch/imported/`. Existing outputs are skipped by
default. See [Unified paper command](clip.md) for status and next-step reports,
and [Import exported papers](import-papers.md) for single-file import,
custom destinations, validation, overwrite behavior, and batch reports.

For manual control over one output filename, the existing paper command also
works. Supply the JSON's `url` value, which is the actual captured page URL:

```powershell
$html = Join-Path $HOME 'Downloads\REPLACE-WITH-EXPORTED-FILENAME.html'
$capture = Get-Content -Raw -Encoding UTF8 -LiteralPath "$html.json" | ConvertFrom-Json
npm run clip:paper -- $capture.url --html $html -o output/browser-fetch/papers/novae-from-extension.md
```

Run from `E:\Paper_Clipper\obsidian-clipper`. `npm run build:cli` builds the converter
if it is not already available. An existing output is protected; use `--overwrite`
only when intentionally replacing it. Failed checks do not replace a previous
accepted Markdown file.

Compare the result with the original manual clip: substantive article sections,
Methods, figure captions, tables, and approximate body length. The standard
quality checks still apply, and passing them is not a proof of exact equivalence.
Do not treat an exported subscription preview as full text.

## Snapshot contract and limits

The pair uses a shared title/timestamp basename. JSON records `schemaVersion`,
`captureMethod` (`clipper-dom`), `extensionVersion`, `sourceUrl` (URL before
capture), `url` (URL at capture), `baseURI`, `title`, `capturedAt`, `charset`,
`htmlFile`, `htmlBytes`, and `status` (`unchecked`). A navigation to another page
during capture is rejected; an anchor-only change is allowed.

- Captures the rendered top-level DOM up to 30 MiB. Does not re-fetch the URL,
  transfer cookies, read browser storage, or access browser profiles.
- Keeps article HTML, metadata, JSON-LD, math data scripts, styles, figure captions,
  tables, and resource URLs. Does not download images or other linked assets.
- Works on a clone: the live page and its input values are not changed.
- Removes executable scripts, inline event handlers, input values, textarea
  content, selected-option markers, nested frames/objects, and Clipper controls.
- Adds UTF-8 metadata and a restrictive CSP to disable execution, forms, and
  remote resource loading when opening the snapshot. This is input for Markdown
  extraction, not a faithful offline visual archive.
- Does not capture unloaded content, shadow-root content, iframe documents,
  PDF viewers, or extension/browser-internal pages. Reader mode is rejected so
  a transformed reader document is not mistaken for the publisher source.
- Page text, attributes, URLs, and JSON-LD can still contain personalized or
  confidential information. Treat exports as private local files; this is not
  a general-purpose secrets scrubber. Check before sharing or committing them.

## Verification

```powershell
npm run test:html-export
npm run test:paper
npx tsc --noEmit --module es2020
```

The type-check override matches the extension build's module setting; the base
tsconfig uses ES6 modules despite existing dynamic imports elsewhere in the repo.

On 2026-10-07, nine export tests and the fourteen existing paper-route tests
passed. The Chrome production build passed (with existing bundle-size warnings).
An isolated Chromium run loaded the actual built extension and exercised an
authenticated local fixture, its dynamic content, the embedded export button,
two downloads, popup error recovery, and offline CLI conversion. Results, Methods,
figure captions, and tables were present in the Markdown without another article
request. No real account credentials or the everyday Chrome profile were used.

Extension testing follows the [Playwright Chromium extension workflow](https://playwright.dev/docs/chrome-extensions).
Firefox, Safari, mobile devices, and native browser download dialogs have not
been exercised in this milestone.

### Real Novae acceptance: 2026-10-07

The user exported the authorized tab at `2026-10-07T12:44:23.964Z`. The HTML was
675,103 bytes, matching the JSON metadata. Offline conversion passed explicit
Main, Results, Discussion, and Methods checks.

The first comparison exposed escaped TeX after the snapshot removed the MathJax
loader. The paper wrapper now normalizes explicitly labelled `.mathjax-tex`
elements before invoking the unchanged Clipper CLI/Defuddle converter. The raw
HTML is retained; a separate prepared copy records all 69 normalized formulas.
This also repairs already-exported snapshots without reloading the extension.

After the fix, `output/browser-fetch/papers/novae-from-extension.md` minus its
five-line YAML header is byte-for-byte identical to
`output/browser-fetch/novae-reference.md`:

- 12,619 whitespace-separated body words in both files.
- Identical article sections and subsection order.
- Six figure image links and captions.
- 69 formulas, including seven display equations.
- 59 reference footnote definitions and the same supplementary-file links.

The source HTML has no actual `<table>` elements; supplementary spreadsheets are
linked, not downloaded or converted. Image files also remain remote links.
This verifies equivalence to the manual clip for this capture, not a general
guarantee for every publisher or every future page state. The expanded paper-route
suite has 16 passing tests, including normalization and real-CLI math regression
coverage. The original HTML and JSON files were not changed.
