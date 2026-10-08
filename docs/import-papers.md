# Import exported papers

Import the HTML/JSON pairs downloaded by the extension's **Export page HTML**
button. The importer reads the captured URL from JSON, processes each paper
offline by default, and publishes Markdown only after the existing paper checks pass.
It does not open a browser, copy login state, or fetch the article again.
Optional `--download-assets` enables image network requests after body checks;
see [local image attachments](paper-assets.md).

## Quick start

Run from `E:\Paper_Clipper\obsidian-clipper`. Build the CLI once after installing
dependencies, or after changing the converter:

```powershell
npm run build:cli
npm run clip -- "E:\Paper_Clipper"
```

The [unified command](clip.md) routes files and directories to this importer and
adds consistent status/next-step reports. `npm run clip:import -- ...` remains
available as the lower-level batch command used in the examples below.

Keep each `.html` and its exact `.html.json` companion together, with the original
download names. The directory scan covers the top level only. Subdirectories and
unrelated files are ignored; orphaned `.html.json` files are reported as failures.
One bad pair does not stop later papers.

The default output is `output/browser-fetch/imported/` in this repository, which
is ignored by Git. Each accepted Markdown uses the HTML basename with `.md` in
place of `.html`. Timestamped exports stay separate even when they are from the
same URL; this is not DOI or content-based deduplication.

Import one pair by pointing to its HTML file, or choose another output directory:

```powershell
npm run clip:import -- "E:\Paper_Clipper\exported-paper.html"
npm run clip:import -- "E:\Paper_Clipper" -o "E:\Paper_Clipper\converted"
```

Do not point the command at the JSON file. For arbitrary saved HTML without an
extension sidecar, use [`clip:paper --html`](paper-clipper.md#local-html-input)
with an explicit page URL instead.

## Checks and options

Before conversion, each pair must have valid UTF-8 and schema version 1 metadata
with `captureMethod: "clipper-dom"`. The captured `url` must be HTTP(S) without
embedded credentials. The metadata's HTML filename and byte count must match the
actual file. HTML is limited to 30 MiB and JSON to 64 KiB. File symlinks are not
accepted. Metadata paths are never used to select files or destinations.

If a browser renamed a download, or only half the pair was saved, obtain a fresh
matching pair. A byte-count match is a consistency check, not a cryptographic
integrity or authenticity guarantee.

Conversion reuses the paper pipeline's MathJax normalization and basic checks:
at least 1,000 words before References, two main-text level-2 headings, and no
recognized subscription-preview notice or access-challenge title. These are
heuristics, not proof that every part of a paper was captured.

```powershell
npm run clip:import -- "E:\Paper_Clipper" --require-section Results --require-section Methods
npm run clip:import -- "E:\Paper_Clipper" --min-words 700 --timeout 90000
npm run clip:import -- "E:\Paper_Clipper" -t "path\to\template.json"
```

`--require-section` can be repeated and checks exact level-2 heading names,
ignoring case. `--timeout` bounds each CLI conversion; it is not a whole-batch
deadline. Custom templates can be JSON files or template directories. Body
checks always run before rendering the custom template.

## Existing files

By default, valid pairs with an existing Markdown destination are `skipped`.
The existing Markdown and its conversion reports are not changed. Skipping
does not re-check the previous Markdown or establish that it matches this input.

To intentionally reprocess and replace existing Markdown:

```powershell
npm run clip:import -- "E:\Paper_Clipper" --overwrite
```

Replacement happens only after the new conversion passes checks. Incomplete
content or a conversion failure leaves the previous accepted Markdown in place.
Directories or links at a Markdown destination are failures, not replacements.
Source HTML and JSON are never moved, renamed, modified, or deleted.

## Reports

Each invocation creates a new `_imports/run-*/report.json` under the output
directory, including for an empty input directory. The CLI prints its location
and totals. The report is updated after each item and includes its input, output,
captured URL, status, quality-check reasons, and error details when available.

| Item status | Meaning |
| --- | --- |
| `success` | Passed basic checks and wrote accepted Markdown. |
| `incomplete` | Conversion ran but content checks failed; no new Markdown published. |
| `failed` | Invalid/missing input, destination conflict, or operational failure. |
| `skipped` | Valid input pair but destination already exists and overwrite is off. |

Validated pairs that reach conversion are copied into the batch run's
`item-0001/`, `item-0002/`, etc. Conversion uses those exact validated bytes even
if a source download later changes. These snapshots are retained, never updated
by later runs. They are ordinary local files, not write-protected archives.
Malformed and skipped pairs do not get conversion snapshots.

Per-paper diagnostics remain under `<paper.md>.runs/run-*/`. Each batch item's
`paperReport` points to that run's retained report, while
`<paper.md>.report.json` is the latest conversion report. Original raw HTML,
prepared math HTML when needed, and extracted Markdown remain available for
diagnosis. A rejected overwrite can therefore have `outputWritten: false` while
the older accepted Markdown still exists.

| Exit code | Meaning |
| --- | --- |
| 0 | All discovered inputs succeeded or were skipped. |
| 1 | At least one failure, no matching exports, or a command-level error. |
| 2 | At least one incomplete paper, with no failures. |

Invalid arguments, inaccessible input directories, missing CLI builds, or invalid
template paths fail before a batch report is created. No automatic retry, file
watcher, scheduling, or Vault import is included. Images remain links unless
`--download-assets` is set; supplementary files are not downloaded. Exports and diagnostics can contain private
page data; protect custom output locations as well as the originals.

## Verification

```powershell
npm run test:import
npm run test:paper
npm run test:html-export
```

The 11 importer tests cover metadata validation, real offline CLI conversion and
formulas, mixed batches, missing pairs, top-level-only discovery, repeat skips,
safe overwrite, output conflicts, custom templates, timeouts, empty inputs and
process exit codes. Test artifacts are retained under the ignored output folder;
no recursive cleanup is performed.

On 2026-10-07, the real Novae pair in `E:\Paper_Clipper` imported successfully with
the default command. Its Markdown body matched the manual reference exactly:
12,619 whitespace-separated words and 69 normalized formulas. A second import
reported one skip and left the source pair, Markdown, and previous conversion
reports unchanged.
