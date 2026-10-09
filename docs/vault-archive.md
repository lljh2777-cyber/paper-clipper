# Vault archiving

The archive stage runs offline after conversion and image downloads, either via
`clip --vault` in one invocation or the separate `clip:vault` command.
The archive stage itself does not re-fetch papers, download attachments, translate titles,
generate scientific summaries, install Obsidian, or change Obsidian settings.
An ordinary directory can be opened as a Vault in Obsidian.

Run from `E:\Paper_Clipper\obsidian-clipper`:

```powershell
npm run clip -- "E:\Paper_Clipper" --download-assets -o "E:\Paper_Clipper\converted"
npm run clip:vault -- "E:\Paper_Clipper\converted" --vault "E:\Paper_Clipper\Paper_Vault" --dry-run
npm run clip:vault -- "E:\Paper_Clipper\converted" --vault "E:\Paper_Clipper\Paper_Vault"
# Or capture/import, download images and archive together:
npm run clip -- "E:\Paper_Clipper" --download-assets -o "E:\Paper_Clipper\converted" --vault "E:\Paper_Clipper\Paper_Vault"
```

Multiple files or directories may be supplied. Directory discovery is top-level
only and selects `<paper.md>.report.json` pairs, not arbitrary Markdown notes.
An orphan report is a visible failure. `--papers-dir Research/Papers` chooses a
relative subdirectory (default: `Papers`). `--json` prints a machine-readable result.
`--dry-run` performs checks and deduplication but writes **nothing**, not even a
report or a new Vault directory.
The unified command has separate conversion/archive statuses and stricter
validation of reused outputs against the requested source and current content
requirements; see [one-command archiving](clip.md#capture-through-vault-in-one-command).

## Layout and metadata

Each paper is an independent package:

```text
Paper_Vault/
  Papers/
    p-<DOI-or-URL-identifier>/
      <year> <shortened-original-title>.md
      <original-attachment-directory>/image-001.webp
      paper.json
  .paper-clipper/
    runs/run-*/report.json
    staging/
```

Folder IDs derive from a short digest of the DOI or URL identity, not content
hashing. A name collision is an error, never a reason to replace a directory.
Metadata contains the full original title even when its filename is shortened.
The Markdown body and relative image paths remain unchanged. Existing custom
YAML properties are preserved; normalized archive metadata replaces only its
owned keys (`title`, `authors`, `year`, `doi`, `journal`, `source`,
`publication_date`, `captured_at`, `converted_at`, `metadata_gaps`,
`metadata_source`, `identity`, `paper_clipper_id`, `archive_status`).

Bibliographic metadata comes only from the retained HTML's article-level
`citation_*` / Dublin Core meta tags, with H1 as a title fallback. The original
title and author spelling/capitalization are preserved. DOI-like strings in the
body/reference list are never used to identify the article. Conflicting DOI
metadata is rejected. A missing DOI is not guessed; it is recorded as a gap and
the normalized source URL becomes the identity. A publication year is taken from
the publisher date, not inferred from digits in the DOI.

`captured_at` is the known page-capture timestamp, while `converted_at` is the
conversion completion time. New HTTP/browser and extension-import reports retain
their known capture time. Older saved-HTML reports may lack it; those notes use
`captured_at: null` with a metadata gap instead of substituting the current time.
`paper.json` records archive time, source paths and copied attachments. Reports
contain private local paths and source metadata; keep them private.

These are preserved source articles (`archive_status: clipped-source`), not
reviewed research notes. No `title_zh`, scientific interpretation, reading-depth
rating, Zotero change, BibTeX update or automatic metadata enrichment is implied.

## Duplicate and conflict rules

Before publishing, the command scans ordinary `.md` files throughout the Vault
and reads YAML with a real parser, including manually written notes and renamed
files. Hidden directories (including `.obsidian` and `.paper-clipper`) are excluded.
Scans are bounded to 5,000 notes and 32 directory levels. Malformed YAML,
unsupported note identity values, or visible symbolic links abort the scan rather
than silently weakening deduplication. Use `doi`, `source` or `url` frontmatter
fields for existing papers; body-only identifiers are not indexed.

- DOI matching is case-insensitive and accepts `doi:` and `https://doi.org/` forms.
- URL normalization removes fragments and known tracking parameters, and sorts
  query parameters; article IDs and other semantic query parameters are retained.
- A matching DOI skips an existing note even when the publisher URL differs.
- A matching source URL is the fallback when DOI information is absent.
- The same URL with different nonempty DOIs, or identity matches to multiple
  existing notes, is a conflict requiring manual review.
- Similar titles are never merged. Two papers with different DOIs and the same
  title can be archived separately.
- Repeat imports never update frontmatter, annotations, files or attachments.
  There is deliberately no `--overwrite` option for the Vault step.

There is no mutable global index to go stale: every invocation reads the current
Vault notes. `paper.json` is a per-paper provenance record, and each real run has
its own report. Interrupted staging directories are retained for inspection.

## Input and publication safety

Only `passed-checks` outputs are accepted. The input Markdown must exactly match
its retained `accepted.md` snapshot, and the raw HTML must stay inside that paper's
conversion artifacts. Unverified edited Markdown is not silently published.
Every archive call now rechecks supported Nature legends against the retained
HTML, including legacy caches, standalone invocations, dry runs and duplicate
identities. A historical `passed-checks` report cannot bypass the current check.
Missing/changed/misplaced legends fail with code `figure-captions` and per-figure
diagnostics under `quality.figureCaptions`. Successful items report their current
`figureCaptions` coverage; unsupported structures are explicitly `not-applicable`.
Existing Vault notes themselves are never rewritten or certified by this check.
The same archive paths independently recheck supported Nature main-body headings
and plain paragraphs (`source-sections` on failure, `quality.sourceSections` for
diagnostics, `sourceSections` on successful items). Unsupported layouts are
`not-applicable`; math/image paragraphs are explicitly skipped, not certified.
See [source section scope](paper-clipper.md#source-section-checks) before treating
a passing report as evidence of completeness.
If images exist, all must have local relative paths matching successful download
records, matching file sizes and supported signatures. Partial or remote image
sets fail. Papers without embedded images do not require an assets report.

Sources and attachment files must be regular files; paths cannot escape their
paper/Vault directories. The original files are only read. The importer stages a
complete note, images and provenance record on the destination filesystem before
publishing the package. An occupied destination is preserved. Different papers
are processed independently; a failed paper does not prevent later valid inputs.
This is not cryptographic authentication of publisher content or a filesystem
sandbox against another program concurrently replacing paths.

A per-Vault lock prevents concurrent tool imports. On normal completion, only
that invocation's single `archive.lock` file is removed; no bulk or directory
deletion occurs. If the process is killed, the lock/staging data can remain.
Check that no import is running before manually removing a stale lock. Cleanup
of old reports and staging directories is always a user operation.

Statuses are `planned` (dry run), `archived`, `duplicate` and `failed`. Exit `0`
means only planned/archived/duplicate items; exit `1` means failures, empty input
or a command-level error. Duplicate status preserves the old note and does not
certify its current body or images.

## Tests and local trial

```powershell
npm run test:vault
npm run accept:vault -- --asset-report "<fresh-asset-report.json>" --vault "<new-trial-vault>"
```

The acceptance command takes a successful five-paper image acceptance report,
previews, archives, repeats, and compares original versus archived body/image
bytes and repeat-run timestamps. It creates a fresh `acceptance.json` beside its
archive report. It uses no network and performs no recursive deletion.

On 2026-10-08, the new trial Vault at `E:\Paper_Clipper\Paper_Vault` passed:
five planned, five archived, five skipped as duplicates on repeat, zero failures;
45 unique attachments and 51 image occurrences retained. All original bodies and
image bytes matched. Original inputs, archived notes and attachments retained
their bytes and modification times on repeat. The source reports in this trial
predate capture-time propagation, so all five record that metadata gap explicitly.
This validates file-based archiving, not the Obsidian desktop UI.

This historical trial predates Nature caption verification. Its old asset report
`run-DbGHT6` is retained as evidence, but its Novae and DeepMet conversion caches
now correctly fail because they lack six and five source legends respectively.
Use newly converted outputs for a new trial; do not modify historical snapshots
or rebaseline them. The real-cache dry run rejected those two papers, planned the
other three, and left all source files unchanged without creating a Vault.

Subsequent user screenshots exposed Frontiers math rendering defects not covered
by those file checks. With explicit user approval, the existing Frontiers note
was backed up outside the Vault and repaired in place: eight `\hdots` commands
and flattened equation (8), with all other characters preserved. See
[math rendering verification](paper-acceptance.md#math-rendering-verification).
The initial archive report remains a historical record; future duplicate imports
will preserve this repaired note, not restore the older source output.
