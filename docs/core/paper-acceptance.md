# Core Acceptance

Run `npm test` after installing dependencies and Playwright Chromium. This builds
the same CLI kernel and runs the acquisition, conversion, body-validation, source-section, caption,
image, identity, import, deduplication, Vault and Skill-installation tests.
Browser extension UI tests are intentionally outside this edition.

The original project's private real-paper matrix is retained as
`scripts/fixtures/paper-acceptance.json` for reference. Captures, manual reference
notes and browser profiles are not included. Thus `npm run accept:papers` with
that default matrix is not a fresh-install smoke test: missing inputs must fail,
not be silently skipped or downloaded. Provide your own authorized inputs and
manifest using `node scripts/accept-papers.mjs --help`.

For the initial extraction, compare the full and core commands against identical
local captures in separate output directories, without asset downloading or
Vault writes. Require identical Markdown and matching pass/rejection outcomes,
including a subscription preview and missing-equation page. This validates a
refactor, not completeness of the original extraction.

`accept:assets`, `accept:math`, `accept:vault` and `accept:clip-vault` remain
available for explicitly supplied local inputs. Read each command's usage before
running it. They may create diagnostic files; math rendering can fetch MathJax.
`accept:captions` from the full project is not included because it tests browser
extension entry points. Core Nature-caption checks run during every conversion
and in the standard regression suite.

Nature source-section checks also run in conversion, custom-template output and
all archive paths. They compare headings and supported plain prose only, reporting
math/image paragraphs as skipped and unknown structures as not-applicable. Missing
source prose must fail even when word-count thresholds pass. Synthetic tests cover
loss, changes, duplication, order, hierarchy and legacy-cache revalidation. Real
capture replay should preserve the existing output bytes and rejection behavior;
it is not a scientific equivalence test for skipped formulas or other structures.

Real Obsidian desktop rendering, new publisher structures and future access
changes still require separate verification. A not-applicable check is not proof
that content was retained.
