# Paper Clipper

The recommended entry point is now [Unified paper command](clip.md):
`npm run clip -- <url | file.html | directory>`. This page documents the existing
lower-level `clip:paper` route, whose existing arguments remain available.

The current route takes an accessible publisher URL, captures HTML, converts it
with the existing Clipper CLI, and checks the extracted body before writing the
requested Markdown file. It runs from this repository, not the published npm
package. Defuddle is unchanged. The extension can also export current-tab HTML
for the same offline conversion route; see [Extension HTML export](html-export.md).

## Setup

Use the Node.js version supported by the repository dependencies (verified with
Node.js 24.18.0 on Windows). From the repository root:

```powershell
npm ci
npm run build:cli
npx playwright install chromium
```

The browser installation is needed for browser mode or automatic fallback. An
HTTP-only run or local HTML import does not launch Chromium.

## One-command capture

```powershell
npm run clip:paper -- "https://link.springer.com/article/10.1186/s13045-021-01131-0" -o output/browser-fetch/papers/hic.md
```

The default `auto` mode first tries HTTP. If the request fails or the extracted
body fails checks, it tries the existing persistent Playwright profile. Each mode
is attempted at most once. Browser fallback does not inherit everyday Chrome
cookies and cannot create access rights.

Choose a mode explicitly when appropriate:

```powershell
npm run clip:paper -- "https://www.nature.com/articles/s41586-025-09969-x" --fetch http -o output/browser-fetch/papers/deepmet.md
npm run clip:paper -- "https://www.nature.com/articles/s41586-025-09969-x" --fetch browser -o output/browser-fetch/papers/deepmet-browser.md
```

By default an existing destination is protected. `--overwrite` permits replacement
only after the new capture passes checks. Rejected content and fetch failures
leave the previous Markdown untouched. With overwrite enabled, the accepted file
is staged on the same filesystem before replacing the previous version.

## Checks and reports

The default checks require:

- No recognized subscription-preview notice or access-challenge title.
- At least 1,000 whitespace-separated prose words within recognized main sections.
- At least two distinct, nonempty main-text headings, such as Main, Introduction,
  Background, Results, Discussion, Methods, or Conclusions. All observed main
  sections must contain prose, either directly or in non-excluded subsections.
- Markdown ATX levels 1-6 and setext headings are recognized. Code blocks, quoted
  headings and headings inside lists cannot establish article sections.
- For supported Nature figure structures, complete source legends retained in
  both the extracted body and final template output.

These are conservative heuristics for research articles. They are not a universal
full-text detector and do not establish paper identity or exact equivalence to a
manual clip. Short papers or unusual heading structures may need different
thresholds or later publisher-specific rules. A nonempty section is not proof
that all of its original paragraphs were retained.

`scripts/paper-validation.mjs` owns the shared body check. It parses Markdown
structure rather than matching heading-looking lines. Prose paragraphs and
procedure-list text count once toward `mainBodyWords`; nested main sections are
not double-counted. Known abstract/back-matter sections (including Funding,
Acknowledgements and References) and their descendants do not count. Neither do
unheaded text, unrelated sibling sections, code, blockquotes, tables, image alt
text, raw HTML blocks, footnote definitions or standalone `$$` display math.
These excluded formats remain in the saved Markdown; this rule only controls
the body-length gate, not conversion or preservation of those structures.

Reports identify `bodyCheck: "markdown-sections-v1"` and provide `sections` with
heading, level, kind, exclusion status, prose words and paragraph counts.
`mainBodyWords` drives the length decision. `bodyWords` and
`wordsBeforeReferences` remain approximate raw-Markdown diagnostics, not gates.
New reasons include `empty-main-section:<heading>` and `empty-section:<heading>`;
existing `too-short` and `missing-main-sections` reasons are retained.

This is a Markdown-side structural heuristic, not a publisher-HTML body-container
check or source-to-output section-preservation proof. Raw HTML body layouts and
unsupported section names can still be rejected. It does not mark references,
tables or math as verified, and does not weaken the separate access/DOI/caption
checks. Conversion-only cached output is still skipped; the unified Vault route
rechecks the retained extraction under the current requirements before archiving.

`--min-words 700` changes the word threshold. Repeat `--require-section` to require
specific nonempty headings in addition to the default checks (case-insensitive,
with numbering retained in the requested name):

```powershell
npm run clip:paper -- "https://www.nature.com/articles/s41592-025-02899-6" --require-section Main --require-section Results --require-section Methods -o output/browser-fetch/papers/novae.md
```

Use `-t path/to/template.json` (or a template directory) for custom output. Checks
always run on body extraction using the minimal template first, so a custom
template cannot hide missing source content or cause an abstract-only page to pass.
For Nature papers with supported legends, a title-only or summary template is
rejected with `output-figure-captions`; use a full-content template instead. The
failed rendered output is retained as `*.rendered.md` for diagnosis. Changing
templates cannot disable the source-caption check.

### Figure legend checks

These are deterministic code checks, with no AI calls or extra network requests.
`nature.com` and its subdomains are supported when the saved HTML contains
`figure .c-article-section__figure-description`. Every paragraph must match the
source text, directly follow the matching figure title, occur once, and retain
its links/citations. Layout whitespace and numeric footnote notation are normalized.
This is a conservative text/position check, not semantic formula equivalence or
proof that the publisher finished loading all content.

Each attempt reports `quality.figureCaptions` for the minimal extraction and,
after extraction passes, `quality.outputFigureCaptions` for the selected template.
Both contain `version`, `status`, `expected`, `matched`, `failed` and per-figure
IDs, titles and errors. Status is `passed`, `failed`, or `not-applicable` with
`unsupported-publisher` / `no-supported-legends`. The last status is not proof
that every figure was captured; other publishers and rewritten proxy hostnames
continue through the existing checks without claiming caption coverage.

Failed extraction adds `figure-captions` to quality reasons. HTTP auto mode can
then try the browser as usual. Failed template output adds `output-figure-captions`
and stops without another fetch or image download. Neither failure publishes an
accepted candidate, replaces an older output, or permits automatic Vault archiving.
Both return exit `2`. Reports and diagnostic captures remain available.

Old conversion caches are also rechecked against their retained source HTML
whenever archiving, including `clip:vault --dry-run`. This happens before DOI
deduplication and does not trust a historical passing report. Missing captions
produce archive error `figure-captions` and exit `1`. A normal conversion skip
without `--vault` still does not revalidate or change the existing Markdown.

### Source section checks

`scripts/paper-sections.mjs` adds the independent `nature-sections-v1` check.
On Nature pages with one `.c-article-body .main-content` container and its known
`section[data-title]` layout, it compares the captured source with Markdown:

- Every recognized main/subsection heading must retain its text, level and order.
- Each supported plain prose paragraph must retain its text, occurrence count and
  order within the same nearest heading. Extra output paragraphs such as figure
  legends do not count as replacements for missing prose.
- Whitespace and numeric local Nature citation notation are normalized; citation
  numbers remain distinct. This does not audit citation definitions or link targets.

This is a **scoped preservation check**, not a whole-article completeness score.
It ignores figures (covered separately above), tables, lists, quotes, code blocks,
hidden content and content outside the recognized main body. Paragraphs containing
recognized math, dollar content or inline images are listed as skipped, not matched.
It does not prove formula correctness, formatting fidelity, authorized full-text
access, or that the publisher had loaded every section into the captured HTML.

Each attempt includes `quality.sourceSections` and, after extraction passes,
`quality.outputSourceSections`. They report `version`, `status`, `scope`,
`expectedSections`, `checkedParagraphs`, `matchedParagraphs`, `skippedParagraphs`
and per-section heading/ID, paragraph counts, errors and numbered skip reasons.
`passed` applies only to that scope; inspect skipped counts even when it passes.
Unsupported publishers/layouts return `not-applicable` with a reason, never a
claim of preservation. Recognized but malformed sections fail conservatively.

Missing/changed content rejects extraction with `source-sections`, or a custom
template with `output-source-sections` (exit `2`). Failed template checks precede
image downloads. No accepted file is published or replaced on failure. All Vault
archive calls also recompute this check on final Markdown, including old caches,
standalone calls and dry runs, before deduplication. Failures use archive code
`source-sections` (exit `1`). Conversion-only skips and existing Vault notes remain
unchanged and are not revalidated. No AI or extra network requests are used.

For an output named `paper.md`, the tool writes:

| Path | Contents |
| --- | --- |
| `paper.md` | Accepted output only. |
| `paper.md.report.json` | Latest run status, quality checks, attempts, and whether output was written. |
| `paper.md.runs/run-*/` | Per-run HTML, extracted Markdown, accepted candidate if available, and report. |

An incomplete attempt is available for diagnosis inside its run directory, even
though it is not published as `paper.md`. A rejected overwrite can coexist with an
older accepted `paper.md`; inspect `outputWritten` and the exit code for the latest
run. Invalid arguments, missing build/template files, and destination conflicts
fail before a run is created and report the error on stderr.

| Exit code | Report status | Meaning |
| --- | --- | --- |
| 0 | `passed-checks` | The extracted source passed basic checks and Markdown was written. |
| 1 | `error` | Operational failure; see stderr and report when available. |
| 2 | `incomplete` | No attempt passed checks; diagnostic captures were retained. |

`url` records the actual final response URL. `contentUrl` records the URL supplied
to Clipper. A publisher's canonical URL is used only when its origin and pathname
match the final URL, avoiding transient redirect query parameters in saved notes.
Cross-origin proxy redirects retain their actual origin for relative links.

Before conversion, explicitly labelled `.mathjax-tex` wrappers with `\(...\)`,
`\[...\]`, or `$$...$$` delimiters are normalized to math elements supported by
Defuddle. This preserves formulas when an exported page no longer contains its
MathJax loader script. Original HTML is retained as captured; a separate
`*.prepared.html` and `normalizations.mathJaxTex` report count record the conversion
input. Code blocks, already-rendered math, and ordinary unlabelled text are not
changed. Custom templates use this prepared input too.

Known PLOS/Frontiers reference links are also preserved in the prepared input,
and Frontiers figure lightbox buttons are unwrapped so captions survive cleanup.
Their counts are recorded as `normalizations.publisherLinks` and
`normalizations.publisherFigures`. Frontiers equation links with missing target
elements fail with `unrendered-equations`; automatic mode then tries a browser.
See [real-paper acceptance and limits](paper-acceptance.md).

HTTP requests, browser readiness, and CLI conversion have bounded timeouts; change
them with `--timeout 90000`. HTML captures are limited to 30 MiB. Only HTML/XHTML
HTTP responses are accepted. This workflow does not download or convert PDFs.

Use `output/browser-fetch/` for local results: it is ignored by Git. Captures may
contain account-related page content; `.browser-profile/` contains login state.
Alternative output/profile paths should receive the same protection.

## Optional browser session

Use `--login` only when establishing access in the dedicated profile:

```powershell
npm run clip:paper -- "https://www.nature.com/articles/s41592-025-02899-6" --login -o output/browser-fetch/papers/novae.md
```

Complete login in the visible window, then press Enter in the terminal. `--login`,
`--headed`, and `--wait-for` select browser mode directly when mode is `auto`.
They cannot be combined with `--fetch http`. The profile is closed after capture,
including failures. Do not run two browser captures against the same profile at
once. See [Browser Fetcher](browser-fetcher.md) for profile and readiness details.

## Local HTML input

An HTML file can enter the same conversion/checking path with no network request
(unless optional `--download-assets` is added):

```powershell
npm run clip:paper -- "https://www.nature.com/articles/s41592-025-02899-6" --html output/browser-fetch/novae-full.html -o output/browser-fetch/papers/novae.md
```

Supply the original page URL, not a `file://` URL, for metadata and relative links.
HTML input is UTF-8. It cannot be combined with `--fetch`, `--login`, or other
browser interaction options. The input file is never modified.

For extension HTML/JSON exports, use `npm run clip:import -- "E:\Paper_Clipper"`
to read the captured URLs automatically and process all top-level pairs. It
preserves sources, skips existing Markdown by default, and reports each paper
independently. See [Import exported papers](import-papers.md).

## Verification

```powershell
npm run test:paper
```

The tests build the real CLI and cover redirects, canonical URLs, HTML conversion,
JavaScript rendering, persistent cookies, HTTP-to-browser fallback, preview
rejection, timeouts, non-HTML responses, offline input, custom templates, and
preserving previous output. Real Chromium tests use local fixtures and do not
require publisher credentials. No recursive deletion is performed.

On 2026-10-07, all 14 tests passed. Live HTTP checks generated Hi-C Markdown
(10,425 body words) and DeepMet Markdown (23,303 body words). DeepMet matched the
existing manual sample after whitespace normalization. The only Hi-C difference
was the absence of the publisher's "Ask a research question" recommendation module.
The saved Novae preview was rejected with subscription-preview, too-short, and
missing-main-sections reasons, without writing an accepted Markdown file. This is
not a successful Novae full-text capture.

The later extension capture completed the Novae comparison on the same date:
after normalizing 69 MathJax wrappers, the Markdown body was byte-for-byte identical
to the manual reference (12,619 words). The paper-route suite now has 16 passing
tests, including script-free math snapshots. See [Extension HTML export](html-export.md).

That historical reference match did not prove caption completeness: both manual
and automatic clips omitted the long Nature legends. The subsequent shared
extraction fix restored six Novae and five DeepMet legends. Runtime checks now
verify those additions independently; see [Nature legend verification](paper-acceptance.md#nature-full-figure-legends).

## Extension HTML export

The extension now has an **Export page HTML** button in its popup and side panel.
It captures the current top-level document without fetching it again. This uses
the content already available in the user's browser, not the dedicated Playwright
profile or the Codex browser connector.

The UTF-8 HTML and companion JSON feed the existing `--html` route. Capture is
marked `unchecked`; a successful download does not mean full text was available.
`clip:import` now automates pairing and batch conversion on top of that route.
See [setup, limitations, and Novae verification steps](html-export.md).

Optional [image downloading](paper-assets.md) is now available through
`--download-assets` on all paper commands. Title/DOI search, batch scheduling,
MCP tools and Vault writes remain outside this milestone.
