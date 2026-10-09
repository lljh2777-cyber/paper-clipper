# Paper Clipper Core

Give an Agent a paper title, DOI or URL; obtain accessible publisher HTML as
Markdown, with optional local images and safe, DOI-deduplicated Vault archiving.
This is an independent, unofficial command-line edition, not an Obsidian extension.

## Install

Use Node.js 22.12+ (tested with Node.js 24). In this directory:

```sh
npm install
npm run build:cli
node scripts/save-paper.mjs --help
```

The exported lockfile starts from the full project's pinned resolution. The
first `npm install` prunes unused dependencies and updates it for this edition.
Keep that resulting lockfile; subsequent installations can use `npm ci`.
No sibling checkout, extension, Obsidian installation or API key is required.

HTTP acquisition and local HTML conversion do not require a browser binary.
For browser fallback, interactive login, and the complete test suite, also run:

```sh
npx playwright install chromium
```

## Use

With the separately installed modified extension, the primary interactive route
is `npm run paper:browser -- "DOI" --download-assets`. Pair once and keep the
browser open; the extension's Paper queue page may close. See [usual-browser queue](docs/browser-queue.md).
The commands below remain available for explicit standalone acquisition.

```sh
node scripts/save-paper.mjs "10.1186/s13045-021-01131-0" --download-assets
node scripts/save-paper.mjs "FULL PAPER TITLE" --resolve-only
node scripts/save-paper.mjs "DOI" --html "exports/paper.html"
node scripts/save-paper.mjs "DOI" --download-assets --vault "PATH_TO_VAULT"
```

Default output is local `output/browser-fetch/agent`. There is no default Vault.
For HTTP-only acquisition use `--fetch http`; `auto` may try the dedicated browser.
The HTML route needs the matching `.html.json` sidecar. It does not fetch the
article again; image requests occur only with `--download-assets`.

The command writes one JSON result to stdout and progress to stderr. A blocked
page, partial capture or ambiguous title is not reported as a successful save.
Existing Vault notes and annotations are never replaced. See
[Paper Agent](docs/paper-agent.md), [unified command](docs/clip.md), and
[authorized export contract](docs/html-export.md).

For automatic import of exports from your normally logged-in browser, run
`npm run clip:watch -- "PATH_TO_DEDICATED_INBOX"` in the foreground. Both the
HTML and JSON files must land in that folder. See [inbox watcher](docs/watch-exports.md).

Optional Codex Skill installation:

```sh
npm run install:paper-skill -- --dry-run
npm run install:paper-skill
```

The Skill points to this directory. An existing Skill pointing elsewhere is
intentionally not overwritten; review migration explicitly. Keep its current
runtime until the new installation has been validated.

## Included And Excluded

Included: title/DOI resolution, HTTP/browser acquisition, authorized HTML import,
conversion and publisher fixes, content checks, local images, safe Vault writes,
JSON reports, regression tests and the optional Skill.

Excluded: popup/side-panel/settings/reader UI, highlighter/editor, extension
manifests, Chrome/Firefox/Safari packaging, translations, store and brand assets,
personal papers/Vaults, browser profiles, installed Skill paths and Git history.

This first extraction retains the existing CLI/template kernel and its small
compatibility modules to keep conversion output unchanged. Custom templates are
still supported by the lower-level `clip` command. The Agent uses the fixed paper
template. A fixed-template-only rewrite is a separate, not-yet-performed step.
`core-manifest.json` lists the reviewed exported files; it is not a runtime input.

## Verify

```sh
npm test
```

The Node regression tests use synthetic fixtures and local servers, including
section-body validation, scoped Nature source-to-Markdown preservation, and
rejected-cache archive checks.
Some need the Playwright Chromium binary. Captures/reports made by tests remain
in ignored output directories; tests do not delete personal data. See
[acceptance](docs/paper-acceptance.md) for private real-paper checks.

Checks are deterministic heuristics, not AI review or proof of full scientific
equivalence. Source checks report skipped math paragraphs and unsupported layouts;
see [scope and limits](docs/paper-clipper.md#source-section-checks).
Unsupported publishers and Obsidian desktop rendering still need
human inspection. No PDF/OCR fallback, generated missing text, paywall bypass,
cookie transfer, literature database or note-taking UI is included.

## License

Derived code from Obsidian Web Clipper retains its MIT notice in [LICENSE](LICENSE).
No official affiliation or extension-store branding is claimed. Third-party
libraries retain their own terms; see [notices](THIRD_PARTY_NOTICES.md).
Rights to acquired papers are separate from the software license.
