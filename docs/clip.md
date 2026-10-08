# Unified paper command

Run from `E:\Paper_Clipper\obsidian-clipper`. The recommended entry point is now
`npm run clip -- <input>`: supply a publisher URL, an extension-exported HTML
file, or a directory of HTML/JSON pairs. Existing commands remain available.

```powershell
npm run build:cli
npm run clip -- "https://www.nature.com/articles/s41592-025-02899-6"
npm run clip -- "E:\Paper_Clipper"
npm run clip -- "E:\Paper_Clipper\exported-paper.html"
```

Known Nature legends are now compared with source HTML during conversion and
again before Vault archiving, including skipped legacy conversion caches. Failed
checks report figure titles and `repair-figure-captions` guidance. No AI is used.
Unsupported publishers/structures are marked `not-applicable`, not verified.
See [figure legend checks](paper-clipper.md#figure-legend-checks) for report fields,
template restrictions and exit codes. Conversion skips without `--vault` still
leave existing outputs unvalidated and unchanged.

The Novae URL example does not guarantee full-text access. URL capture uses HTTP
first, then the dedicated Playwright browser if needed. It does not inherit
everyday Chrome login state. Browser fallback requires Chromium to be installed
with `npx playwright install chromium`. Offline imports do not launch a browser.

## Routing and destinations

| Input | Route | Default Markdown destination |
| --- | --- | --- |
| HTTP(S) URL | Existing HTTP/browser paper pipeline | `output/browser-fetch/papers/<URL-based-name>.md` |
| Exported `.html` | Offline import with adjacent `.html.json` | `output/browser-fetch/imported/<HTML-basename>.md` |
| Directory | Top-level HTML/JSON pairs, processed independently | `output/browser-fetch/imported/<HTML-basename>.md` |

URL filenames use the host, final path component and a short URL digest so
different paths or query strings do not normally collide. Fragments such as
`#Methods` are ignored for naming. This is a stable filename identifier, not a
content checksum or DOI-based deduplication. Different URLs can still describe
the same paper. Export filenames and timestamps remain unchanged.

`-o` / `--output-dir` always means a **directory** in the unified command:

```powershell
npm run clip -- "https://example.com/article" -o "E:\Paper_Clipper\converted"
npm run clip -- "E:\Paper_Clipper" -o "E:\Paper_Clipper\converted"
```

For one exact URL output filename, use `--output` instead:

```powershell
npm run clip -- "https://example.com/article" --output "E:\Paper_Clipper\converted\paper.md"
```

Do not combine `--output` and `--output-dir`. Local imports accept only an output
directory. In the legacy `clip:paper` command, `-o` still means a Markdown file;
its behavior has not changed.

## Options and file protection

Common options are `--min-words`, repeated `--require-section`, `--timeout`,
`-t` / `--template`, `--overwrite`, `--download-assets`, `--vault` and `--papers-dir`. They use the existing body checks and
template rendering rather than a separate converter. Math normalization remains
enabled for both routes. See [paper checks](paper-clipper.md#checks-and-reports).

URL-only options are `--fetch auto|http|browser`, `--profile`, `--login`,
`--headed`, `--wait-for`, and `--settle`. Using one with a local input is an error,
not a request to re-fetch its URL. Browser timeout must exceed the settle interval
(default 1,500 ms). `--login` requires an interactive terminal and waits for Enter
after manual login; its browser profile is separate from everyday Chrome.

```powershell
npm run clip -- "https://example.com/article" --fetch http --require-section Methods
npm run clip -- "E:\Paper_Clipper" --require-section Results --require-section Methods
npm run clip -- "E:\Paper_Clipper" --overwrite
npm run clip -- --help
```

Both routes skip existing regular Markdown files by default. A skipped URL is
not fetched at all. A skipped local pair is validated but not converted. A skip
does not certify the contents of the existing Markdown. Directories or links at
the Markdown destination are rejected. `--overwrite` replaces a file only after
the new result passes checks; failed or incomplete attempts preserve the previous
Markdown. Original HTML/JSON inputs are never changed or removed.

Local inputs require the extension sidecar contract; they are not arbitrary HTML
files or browser-fetcher reports. See [pair validation](import-papers.md).
For raw HTML without a sidecar, keep using `clip:paper <url> --html <file>`.

## Status and next steps

Every result uses the same status vocabulary in the terminal and unified report:

| Status | Meaning | Next action |
| --- | --- | --- |
| `success` | Basic checks passed and Markdown was written. | Review sections, formulas, tables and captions. |
| `incomplete` | Capture converted but content checks failed. | Inspect reasons and retained captures; export a fuller authorized page when available. |
| `failed` | Operational error or invalid input. | Correct the input/environment using the error details. |
| `skipped` | Existing regular Markdown was preserved. | Review it, or intentionally reprocess with `--overwrite`. |

HTTP 401/403 responses, recognized subscription previews and access-challenge
pages suggest **Export page HTML** from a browser tab where the user already has
full-text access. Keep both downloads together and run the same unified command
on their folder. A login, export or successful download cannot create access
rights or recover unloaded content. An ordinary 404, timeout or template error
is not labeled as proof of a paywall.

The terminal prints the destination, whether it was written, retained diagnostic
paths, check failures and a next step. Both routes create a fresh
`<output-directory>/_clips/run-*/report.json` with schema version 1, route, input,
counts, item statuses, `outputWritten`, and machine-readable `nextStep.code` plus
human-readable `nextStep.message`. Missing local paths and preflight failures are
also recorded when the output directory is writable.

The original detailed reports are retained unchanged: URL items link to their
per-run `paperReport`; import reports also have a `sourceReport` pointing to the
batch report. Skipped items have no new conversion report. Unified reports show
`running` until completion; during a batch, the underlying `_imports/` report is
updated per item. A forcibly interrupted run can therefore remain `running`.
Invalid arguments, unsafe Vault/output paths or an unwritable report directory can fail before a report is
created. No resume or automatic retries are implied.

Exit codes remain `0` for success/skipped only, `1` for any failure or empty input,
and `2` for incomplete content when no failures occurred. A failed HTTP access
request is exit `1`; a converted subscription preview is exit `2`.

Default artifacts are Git-ignored. Custom paths need the same privacy protection:
reports, captures and source URLs may include account-related information. This
command does not add background Vault synchronization, scheduling or MCP.
Accepted outputs can be archived in the same invocation with `--vault`, or with
the separate [`clip:vault` command](vault-archive.md).

## Capture through Vault in one command

```powershell
npm run clip -- "https://link.springer.com/article/10.1186/s13045-021-01131-0" --download-assets --vault "E:\Paper_Clipper\Paper_Vault"
npm run clip -- "E:\Paper_Clipper" --download-assets -o "E:\Paper_Clipper\converted" --vault "E:\Paper_Clipper\Paper_Vault"
```

Both URL capture and HTML imports run the same offline archive stage after
conversion. `--papers-dir Research/Papers` changes the relative destination
inside the Vault and requires `--vault`. Conversion outputs must be outside the
Vault; symlink/junction paths are refused before conversion starts.

- Only accepted content with complete local images can enter the Vault. Failed
  or incomplete conversion never falls back to publishing an older output.
- `--vault` alone does not enable image downloads. Use `--download-assets` for
  papers with remote images. Partial images remain in conversion diagnostics,
  but block publication and cause exit `1` with `repair-assets-before-archive`.
- A skipped conversion is revalidated against its retained accepted snapshot,
  source URL, current word/section requirements and local attachments. Missing,
  modified or mismatched saved artifacts fail archiving visibly.
- Skipping reuses the saved capture, even if a same-URL HTML export has changed.
  To regenerate old conversion outputs or add local images, deliberately use
  `--overwrite`; that option **never overwrites existing Vault notes**.
- Deduplication occurs after validation, by DOI then canonical URL. Existing
  notes, metadata and annotations are preserved. `duplicate` does not certify
  the current contents of that existing note, nor avoid all initial capture work.

Unified reports keep conversion `counts` and item `status` unchanged. Separate
`archive.counts` and `item.archive` describe `archived`, `duplicate`, `blocked`
or `failed`, including the archive report path, destination and error. A stored
`phase: archiving` distinguishes an interrupted archive from conversion. The
next action prioritizes the archive outcome.

Exit `0` means conversion/skip and archiving/duplicate succeeded; `1` also covers
any archive failure or unresolved images; `2` remains incomplete content only.
Batch papers are independent, not a single all-or-nothing transaction. There is
no unified `--dry-run`: preview existing conversions without any writes using
`npm run clip:vault -- <converted-directory> --vault <vault> --dry-run`.

## Optional local images

`npm run clip -- <input> --download-assets` saves images beside the Markdown and
uses relative image paths. This is a network opt-in even for local HTML imports.
Failures preserve the original URL, report `assets.status: partial`, and suggest
`review-assets`; without `--vault` the paper can still be saved with exit `0`.
With `--vault`, unresolved images instead prevent archiving and cause exit `1`. Existing Markdown
continues to be skipped unless `--overwrite` is explicit. See
[local image attachments](paper-assets.md) for examples, limits and offline tests.

## Verification

```powershell
npm run test:clip
npm run test:import
npm run test:paper
npm run test:html-export
```

The unified suite exercises 13 scenarios: routing/flags, safe stable filenames,
argument rejection, actual URL conversion, repeat skips without network access,
safe overwrite, differentiated access advice, real Chromium fallback, offline
single and batch imports, custom templates, preflight/empty-input reports, and
process exit codes. Test servers are local and require no publisher credentials.
The Chromium test closes its context, and no recursive deletion is performed.

The suite now includes a fourteenth scenario for the `render-equations` recovery
step and a fifteenth for optional asset downloads through both routes.
Nine additional `clip-vault` scenarios cover both archive routes, mixed batches,
identity conflicts, partial images, current cache checks, source mismatches,
annotation preservation, directory links, locks and CLI exit codes.

On 2026-10-08, live Hi-C capture and the saved authorized Novae export both
completed conversion, image downloads and archiving: 2 notes, 13 attachments,
zero failures. Both repeated as conversion skips and Vault duplicates. Exact
body/image comparisons and byte/mtime checks passed for 34 source/archive files;
Novae retained its original export capture time. To repeat that verification:

```powershell
npm run accept:clip-vault -- --report <first-unified-report.json> --report <another-first-report.json>
```

This runner requires successful first-time archive reports, reuses their saved
conversion outputs and writes a fresh verification report. It is not an Obsidian
desktop rendering test.
See [Real-paper acceptance](paper-acceptance.md) for the five-paper matrix,
three negative captures, publisher-specific fixes, and `npm run accept:papers`.
