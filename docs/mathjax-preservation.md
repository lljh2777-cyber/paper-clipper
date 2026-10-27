# MathJax capture and formula preservation

Manual clipping, HTML export and the browser queue capture original MathML or
TeX already held by MathJax 3/4. This covers lazy placeholders such as those on
PMC without requiring the reader to scroll through every equation. The capture
runs in the selected top frame, pairs each input with its exact rendered DOM
element, and adds it only to a sanitized snapshot. It does not change the page,
read cookies, fetch another article, or force MathJax to render.

The existing Clipper/Defuddle pipeline and formula checks remain in place.
Unavailable or unsupported source still stops conversion. The error message is
short; the complete per-formula report is carried as `formulaPreservation` on the
error/response rather than concatenated into the visible message. Expected
validation failures are warnings, while unexpected runtime errors remain errors.

Two source-backed layout corrections prevent loss during extraction:

- Captions containing normalized formulas are retained beside their figure as
  rich content, preserving repeated occurrences, links and emphasis.
- A `table.disp-formula` with exactly one equation cell and one numeric label
  cell is unwrapped into a display equation and its number. Genuine data tables
  are not unwrapped. This avoids Markdown table escaping of TeX norm bars.

Unfenced display MathML tables use the same `aligned` representation as the
existing converter. Fenced matrices, row/cell contents, fonts, occurrence counts
and inline/display distinctions continue to be checked.
Literal underscore operators in identifiers are escaped as `\_`; they are not
the `\underline` accent command. Actual under/over accents retain their role.

MathML `alttext` describes accessibility content and is not treated as TeX source.
For example, Cell may set every formula's description to "No alternative text
available". Explicit TeX attributes, typed annotations and TeX scripts retain
priority; otherwise the converter uses the MathML structure. A description
without recoverable mathematical source still fails the existing checks.

## Verification boundaries

Synthetic tests cover MAIN-world retained MathML/TeX, lazy placeholders, exact
DOM association, invalid source, navigation races, rich captions, numbered
equations, source non-mutation, CLI/API parity and ZIP checks at all three stages.
They also cover placeholder descriptions, simple variables, typed TeX priority
and rejection of descriptions presented as formulas. ZIP rendering tests use
the formulas read back from the exported Markdown.
Hosted Chromium tests exercise the actual extension and the bounded failure UI.
No private article HTML is committed or sent to CI.

The public PMC13557097 source was checked locally against a snapshot with its
101 original MathML formulas. This source-backed reconstruction is separate
from acceptance of the user's currently open browser page. Science's rendered
HTML and browsers other than Chromium require separate acceptance. The optional
dedicated Playwright fetcher is unchanged; snapshots already missing both the
original source and supported rendered math cannot recover it offline.

Local acceptance on 2026-10-27 used the user's exported Cell HTML for DOI
`10.1016/j.cell.2022.05.013`. Before the fix, its nine descriptions were mistaken
for TeX and only two occurrences matched. After the fix, all nine source formulas
matched the CLI output, including two display equations, and the exported TeX
rendered without errors. The earlier Cell sample retained 29/29 formulas and
the source-backed PMC snapshot retained 101/101. These are formula checks on
specific saved inputs, not proof of whole-article completeness or a live-browser
acceptance. Original files and existing paper archives were not changed.
