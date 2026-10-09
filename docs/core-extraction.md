# Standalone Core Extraction

The full project remains the development baseline. `export:core` produces an
independent command-line directory without removing or moving existing files.
It copies an explicit allowlist, not a recursive checkout or Git history.

```sh
npm run test:core-export
npm run export:core -- -o ../paper-clipper-core --dry-run
npm run export:core -- -o ../paper-clipper-core
```

An existing destination (even empty), linked parent or missing source file is
rejected. Use a new directory for a later export; the command never replaces a
previous core, installed Skill, capture or note. After export, run `npm install`
and `npm run build:cli` there. Install Playwright Chromium for browser capture
and `npm test`. The seeded lockfile preserves existing resolutions; npm prunes
unneeded entries on first install. Preserve the resulting lockfile for `npm ci`.

This is a standalone source edition, not a ZIP, binary release, second Git clone
or change to the current Skill runtime. It needs no sibling checkout to build
or run. The original repository retains the export recipe and all source code;
the generated sibling directory is outside that repository. Do not treat local
edits to a generated copy as upstream changes: make durable changes in the source
first, then export and validate again.

## Scope

Keep acquisition, conversion, existing publisher fixes, checks, images, safe
Vault archive, JSON reports, Skill installer and the existing regression tests.
Do not copy extension UI, editor, reader/highlighter, translations, manifests,
multi-browser packaging, branding, screenshots, private data or installed paths.

The template kernel is intentionally unchanged in this first stage. Its small
browser-compatibility modules and lower-level template/CLI capabilities remain.
The Agent still uses the fixed minimal paper template. This is not yet a rewrite
to a fixed-template-only converter or a minimal logged-in-tab exporter.

## Verification: 2026-10-08

Environment: Windows, Node.js 24.18.0. The core installed its own node_modules
in a fresh sibling directory and built successfully without extension tooling.

| Measure | Full Baseline | Core |
| --- | ---: | ---: |
| Tracked/exported files, excluding generated runtime data | 319 | 70 |
| TypeScript source files under src | 100 | 20 |
| Direct dependencies, including development tools | 42 | 11 |
| Lockfile dependency entries, including optional platforms | 397 | 92 |

File counts use the committed full baseline `0027107`; the new export tooling
itself is not part of that baseline count. The generated manifest is included in
the core file count. Lockfile entries are not the installed package count.

- Core export checks: 4 passed (allowlist, locked versions, dry run, no overwrite,
  regular-file validation and linked-parent refusal).
- Independent core `npm test`: 122 passed, 0 failed, 0 skipped.
- All 8 real-capture scenarios passed their existing acceptance criteria in both
  editions. Markdown was compared as bytes, not hashes or normalized prose.
- Successful cases: Hi-C, DeepMet, authorized Novae export, PLOS and Frontiers.
- Expected rejections: Novae subscription preview, Frontiers missing equations,
  and eLife access challenge. Diagnostics and rejected Markdown also matched.
- Each pair had identical exit status, acceptance status, rejection reasons and
  structural metrics. No image downloads, source edits or Vault writes were used
  for this comparison.

Private local reports (ignored, not distributed):

- Full: `output/core-comparison/full/run-deVGHx/report.json`.
- Core: `output/core-comparison/core/run-dbIuDn/report.json` in the sibling core.

This establishes extraction equivalence for the available fixtures. It does not
prove every publisher works or independently verify Obsidian desktop rendering.
Browser-extension tests and future upstream template changes are outside the
core suite. The existing installed Skill still points to the full project;
migration should be an explicit subsequent step, not an installer overwrite.

## Section Validation: 2026-10-09

The full checkout remains the maintenance source. The independent core received
the same reviewed script/document updates after checking its affected files
against the previous export. No existing Skill runtime or personal Vault was
changed. The export allowlist now includes `paper-validation.mjs` and its unit
tests (72 exported files; still 20 TypeScript files and 11 direct dependencies).

Body validation is now owned by `scripts/paper-validation.mjs`. The archive module
imports that module directly; `clip-paper.mjs` retains a compatibility re-export.
Reports identify `markdown-sections-v1` and include per-section prose counts.
See [body-check semantics and limits](paper-clipper.md#checks-and-reports).

Validation completed in the independent core:

- `npm test`: 139 passed, 0 failed, 0 skipped (17 new regression tests).
- Full-checkout export tests: 4 passed.
- New regressions cover empty sections padded with funding text, heading levels,
  setext headings, code/quote/list pseudo-headings, back matter, nested sections,
  required empty sections and revalidation of legacy accepted caches.
- Both editions replayed all 8 existing private capture scenarios successfully.
  The core's Markdown was byte-identical to the previous core's output for all
  8 cases. Five articles remained accepted; the same three blocked/incomplete
  inputs remained rejected. Thresholds and reference baselines were not lowered.
- Private reports: full `output/section-validation/acceptance/run-1u7d2v/report.json`;
  core `output/section-validation/acceptance/run-j3NPGK/report.json`.

This milestone changes only Markdown-side validation and diagnostics. It does
not implement source-HTML body-region detection, prove source-to-output section
preservation, revalidate conversion-only skips, or change standalone archive
behavior when no current checks are requested. Authentication/session-reuse
acceptance, CI and a broader quality-status schema remain separate work.

## Source Preservation: 2026-10-09

The next bounded step adds `scripts/paper-sections.mjs` and its tests to the
allowlist (74 exported files; still 20 TypeScript files and 11 direct dependencies).
Fourteen reviewed files were synchronized into the existing core after comparing
all affected existing files byte-for-byte with the previous export. No dependency,
converter kernel, personal note, capture baseline or installed Skill was changed.

`nature-sections-v1` independently compares known Nature main-body structures with
the extracted and final Markdown, and rechecks final output on every Vault archive
path, including legacy caches and standalone dry runs. Missing, changed, duplicated,
misnested or reordered supported content blocks publishing/archiving. See
[scope and report fields](paper-clipper.md#source-section-checks).

Completed verification:

- Full checkout `node --test scripts/*.test.mjs`: 157 passed, 0 failed/skipped.
- Independent core `npm test` (including CLI rebuild): 153 passed, 0 failed/skipped.
  The difference is the four full-checkout exporter tests.
- Both editions replayed the same 8 private capture cases successfully. All 8
  Markdown outputs were byte-identical between editions and against the previous
  core section-validation run. No network acquisition, asset downloads or personal
  Vault writes were used in the replay.
- DeepMet: 37 main/subsection headings, 110 checked and matched prose paragraphs.
- Novae: 30 main/subsection headings, 33 checked and matched prose paragraphs,
  16 math-containing paragraphs explicitly skipped. Display equations outside
  prose paragraphs are also outside this check, not implicitly verified.
- Removing a Main paragraph in memory from each real Nature output caused the
  new check to fail. The saved captures and Markdown were not edited.
- Synthetic regressions exercise extraction loss despite sufficient word count,
  title-only custom templates, unchanged old output bytes/mtime on rejection,
  legacy URL/import caches, standalone archives/dry runs and untouched annotations.

Private reports (ignored): full
`output/source-sections/acceptance/run-yKlRsZ/report.json`; core
`output/source-sections/acceptance/run-MiVvXo/report.json` in the sibling edition.

This does not certify the whole article. Source recognition is intentionally
Nature-specific, unknown layouts remain not-applicable, and skipped math/image
paragraphs, tables/lists and citation targets require separate checks. Access and
Markdown structural gates remain independent. Authentication restart acceptance,
CI, broader publisher adapters and any migration of the installed Skill are still
separate work. At this verification checkpoint, these validation changes had not
yet been committed or pushed.
