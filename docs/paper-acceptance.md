# Real-paper acceptance

Validation date: 2026-10-08. This is a sample matrix, not a guarantee that every
article from a publisher is supported. Five full-content samples and three
negative captures are retained locally. No source captures or manual baselines
were overwritten or added to the regression fixtures in Git.

## Results

| Sample | Tested route | Acceptance level | Words | Result |
| --- | --- | --- | ---: | --- |
| [Hi-C](https://link.springer.com/article/10.1186/s13045-021-01131-0) | Live HTTP plus offline replay | Manual reference with declared exclusion | 10,425 | Matches after whitespace normalization and excluding the manual clip's unrelated `Ask a research question` module. |
| [DeepMet](https://www.nature.com/articles/s41586-025-09969-x) | Live HTTP plus offline replay | Legacy reference plus five source-verified legends | 24,420 | Restores five full legends; remaining body matches after the two reviewed math corrections and whitespace normalization. |
| [Novae](https://www.nature.com/articles/s41592-025-02899-6) | Original authorized extension HTML/JSON through unified import | Legacy reference plus six source-verified legends | 13,695 | Restores six full legends; remaining body exactly matches the legacy reference. Retains 69 formulas, seven display equations, six images and 59 reference definitions. |
| [PLOS binomial model](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1012386) | Live HTTP plus offline replay | Source-structure checks, no manual baseline | 15,975 | All 67 citation-link occurrences, seven figure images, 11 equation images, and 14 figure-title/legend blocks preserved. |
| [Frontiers LFSC](https://www.frontiersin.org/journals/genetics/articles/10.3389/fgene.2022.1068075/full) | Live HTTP-to-browser fallback plus offline replay | Source-structure checks, no manual baseline | 7,594 | 95 dollar-delimited formulas; all three tables (312 cells with row/column spans), 54 internal-reference links and eight figure captions preserved. |

Counts are diagnostics, not a universal measure of completeness. Markdown word
counts include syntax. Image totals can also include journal graphics or gallery
duplicates; the PLOS audit separately checks all 18 required source image URLs.
The Frontiers table audit compares every row/cell text and its spans, not only
the number of tables. Link audits account for repeated occurrences.

Negative cases all return exit `2`, retain diagnostics, and do not publish
accepted Markdown:

- **Novae preview:** rejected for subscription preview and missing main sections.
  The presence of figure links and references does not make this full text.
- **Frontiers unrendered HTTP:** rejected for `unrendered-equations`, even though
  its body is long enough. Automatic mode proceeds to browser rendering.
- **[eLife client challenge](https://elifesciences.org/articles/69324):** both live
  HTTP and browser attempts returned a challenge, not the article. The saved
  capture is now classified as `access-challenge`. No access bypass was attempted.

## Fixes from this round

1. **Missing PLOS and Frontiers links.** Defuddle's cleanup removes fragment links
   with reference-like classes. Before conversion, the paper wrapper now preserves
   known `ref-tip` / `ArticleReference` labels and resolves their destinations to
   the publisher URL. This is narrowly scoped to the observed publisher domains
   and structures; it does not invent citations or modify unrelated sites.
2. **Missing Frontiers formulas in server HTML.** Equation links pointed to absent
   `e<number>` elements while formulas were empty spans. The source inspector now
   fails that known structure and lets automatic mode try a browser. Local HTML
   with the same gap is rejected and must be re-exported after formulas load.
3. **Missing Frontiers captions.** The publisher wraps figures and captions in a
   lightbox button. The wrapper unwraps only these figure buttons before UI cleanup,
   retaining the captions while ordinary download/expand controls are removed.
4. **eLife challenge classification.** The `Client Challenge` title is recognized
   as an access challenge, including when a challenge contains a long body.

The four fixes above are paper-wrapper fixes, shared by URL capture and exported-HTML conversion.
They do not patch Defuddle or the extension's direct Save-to-Obsidian conversion.
No extension rebuild is needed to use the fixes with exported HTML.
Original HTML remains untouched; prepared copies and normalization counts are
retained in conversion reports.

The DeepMet difference is a correction from the earlier MathJax normalization,
not a new loss: its old manual Markdown double-escaped two TeX equations. Both
new formulas were checked against raw `.mathjax-tex` content. The acceptance
manifest contains exactly two literal, one-occurrence reference replacements
with reasons. It never rewrites the manual file, applies blanket unescaping,
or automatically accepts a new baseline.

## Reproduce locally

From `E:\Paper_Clipper\obsidian-clipper`:

```powershell
npm run accept:papers
```

The command builds the real CLI, then replays the eight saved cases **offline**.
It creates `output/browser-fetch/acceptance/runs/run-*/report.json` and
`summary.md`, along with new per-paper conversion artifacts. It never performs
a live fetch, starts a browser, replaces an accepted file, deletes sources, or
updates its own expected results. It exits `1` if any assertion or input fails,
and `0` only when every case meets its declared acceptance level.

The manifest is `scripts/fixtures/paper-acceptance.json`. It references local
captures and manual files; the default manifest is intentionally not a clean-clone
CI test. Missing captures fail visibly instead of being skipped. Capture reports
contain absolute HTML paths, so moving the workspace requires updating those
paths or making new captures. To use another local sample set:

```powershell
npm run accept:papers -- --manifest "path\to\samples.json" -o "output\browser-fetch\my-acceptance"
```

Fresh live checks remain explicit `npm run clip -- <url>` invocations with new
output filenames. This separates network/publisher changes from offline converter
regressions. The current Hi-C and DeepMet live outputs were also compared with
their manual baselines under the declared rules.

Focused tests require no private papers:

```powershell
npm run test:acceptance
npm run test:paper
npm run test:clip
npm run test:import
npm run test:html-export
```

The acceptance tests cover comparison tolerances, exact reviewed corrections,
structured Markdown/HTML table checks, missing source features, repeated items,
and missing local inputs. Markdown is parsed with [Marked](https://marked.js.org/using_advanced)
and inspected with Linkedom without executing scripts or fetching resources.
Dollar-math counts are a delimiter diagnostic, not a TeX rendering or semantic
equivalence test. The conversion regressions use small authored fixtures for
publisher links, figure buttons, unrendered equations and client challenges.

## Math rendering verification

User screenshots on 2026-10-08 exposed two Frontiers LFSC conversion defects:
the MathML converter maps U+22EF (centered ellipsis) to `\hdots`, and nested
MathML case tables could be flattened into plain text before TeX conversion.
The first caused four failing expressions; the latter broke equation (8).

The pipeline now supplies source-derived TeX before cleanup for these MathML
structures. It uses the already installed `mathml-to-latex` converter, now an
explicit dependency, and changes accounted-for centered ellipses to `\cdots`.
Existing explicit TeX, code, annotations and ambiguous mixed ellipses are left
alone. Raw HTML is retained unchanged. Reports record `mathMLEllipses` and
`mathMLTables` under normalizations; authored tests cover both fixes.

The supported `\cdots` command is listed in the
[MathJax command reference](https://docs.mathjax.org/en/v3.2/input/tex/macros/index.html).
Obsidian uses MathJax for [mathematical notation](https://obsidian.md/help/advanced-syntax).

The existing trial Vault note was separately backed up and patched with user
approval, changing only eight ellipsis commands and source-derived equation (8).
The complete pre-repair backup is in `E:\Paper_Clipper\Paper_Vault_Backups`.

```powershell
npm run accept:math -- --before <backup.md> --markdown <repaired.md> --source-html <original-browser.html> --equation-id m49
```

This narrow repair-verification runner checks the exact permitted text changes,
downloads the pinned MathJax 3.2.2 SVG renderer, then renders all detected dollar
formulas locally in Chromium with browser networking blocked. It disables the
undefined-command fallback so unknown macros become explicit errors. Results:
95 expressions, 5 failing before repair, **95 rendered with zero syntax errors
after repair**. Changed formulas have a saved SVG preview and screenshot under
`output/playwright/paper-math`. The browser is closed after each run. The preview
omits the assistive MathML layer and is not an Obsidian screenshot.

This checks this sample's TeX syntax/renderability, not complete scientific
equivalence, all publishers, or the user's actual Obsidian version/theme/plugins.
The repaired note still needs the user's final reading-view confirmation.

## Nature full figure legends

Screenshots on 2026-10-08 revealed that both manual and automatic Novae clips
kept figure titles but omitted the detailed panel legends. Nature places those
paragraphs in `.c-article-section__figure-description`, outside `figcaption`.
Defuddle rebuilt each figure using only its image and first `figcaption`.
The earlier exact manual-reference match therefore did not establish completeness:
the manual baseline had the same omission.

`prepareDocumentForExtraction` now clones Nature documents and moves each separate
legend immediately after its figure before extraction. Rich paragraph content,
links, emphasis, superscripts and formulas survive; the live page and original
HTML remain untouched. The helper is shared by API/CLI extraction, manual clipping,
Save Markdown, reader views and fetched highlights. Other hostnames are unchanged.
No access permissions or authentication handling changed.

The stored manual references remain unmodified. Acceptance explicitly declares
six added legends for Novae and five for DeepMet. Each paragraph must match the
source text in full, directly follow the matching title, occur once, and preserve
its links (bibliography links may become defined footnotes). Only those validated
additions are removed for the legacy body comparison. Missing, shortened, moved,
duplicated or link-stripped legends fail. Reports use `reference-plus-source-legends`.

The existing Novae trial Vault note was backed up to
`E:\Paper_Clipper\Paper_Vault_Backups\novae-before-caption-fix-2026-10-08T03-07-45-717Z.md`
and patched with only the six missing paragraphs. Frontmatter, existing prose,
image paths, annotations and end-of-file formatting were preserved exactly.
DeepMet's existing Vault note and historical manual clips were not rewritten.

```powershell
npx vitest run src/utils/publisher-figures.test.ts src/api.test.ts src/utils/page-html-export.test.ts --maxWorkers=2
npm run accept:papers
npm run accept:captions -- --source-html <original.html> --markdown <repaired-note.md> --url <article-url> --before <backup.md>
```

The caption runner uses native Chromium DOM parsing and the actual sync, async
and Save Markdown extraction functions, with all browser networking blocked.
All three paths preserved all six Novae legends. It checks the narrow note diff,
loads the existing local figure attachments, saves an HTML preview and Figure 1
screenshot under `output/playwright/paper-captions`, and closes the browser.
This preview is not verification inside Obsidian itself.

Verification: 87 Node pipeline tests, 16 focused Vitest tests and all eight paper
acceptance cases passed. Chrome production build passed with bundle-size warnings.
The full Vitest suite has 223 passing and six failing existing template fixture
comparisons (CRLF/LF differences, plus a fixed-timezone expectation in YouTube);
those fixtures do not use the Nature preparation helper and were not rebaselined.

Reload the local unpacked extension from `dist` and refresh the paper tab to use
the manual fix; building does not update a store-installed extension. For old
automatic conversion caches, use a fresh output filename or explicitly regenerate
with `--overwrite`. Vault deduplication still protects existing notes and does not
overwrite them. The repaired Novae Vault note needs no re-import.

The subsequent runtime integration applies the same source checks on every new
automatic conversion (minimal extraction and final template), and recomputes them
before archiving, even for legacy caches or standalone dry runs. Missing legends
are no longer only test failures: they prevent publication/archiving and identify
the affected figures in reports. Unsupported publisher structures are explicitly
`not-applicable`. No AI is called. See [runtime behavior and report fields](paper-clipper.md#figure-legend-checks).

Runtime verification passed 93 Node pipeline tests and all eight offline paper
cases. New Novae/DeepMet outputs passed 6/6 and 5/5 legend checks. A read-only
archive trial of the five historical image-localized outputs rejected exactly
the two old Nature caches (six and five missing legends) and planned the other
three. Source bytes/timestamps were unchanged and no Vault was created. This
does not modify or revalidate the separate existing Vault notes.

## Remaining limits

- PLOS and Frontiers have source-structure coverage, not an independently supplied
  manual Markdown comparison. Their complete prose and all scientific notation
  have not been certified equivalent by a human reviewer.
- PLOS equations in this sample are images, not TeX. Images remain remote by
  default; optional [local image attachments](paper-assets.md) were subsequently
  verified on all five samples on 2026-10-08. This offline conversion replay still
  does not download/test remote images. Supplementary files are not downloaded.
- Frontiers may preserve extra journal graphics and repeated equation labels.
  Several captions already lack their first letter in the captured publisher DOM;
  the converter preserves that source text instead of guessing missing letters.
- `unrendered-equations` detects the observed Frontiers structure, not every form
  of incomplete hydration or missing formula. Other publishers still need samples.
- eLife remains unverified for full text in this environment. A legitimate loaded
  tab exported by the user can be tested later without transferring cookies.
- Captures and reports remain private local artifacts. The runner preserves all
  diagnostic runs; any directory cleanup must be done manually by the user.
