# Paper Clipper

Paper Clipper is independently maintained by [@lljh2777-cyber](https://github.com/lljh2777-cyber) and is based on
[Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper).
Resolve a title, DOI or URL, obtain accessible publisher HTML, convert it to
Markdown, check supported content structures, and optionally archive local images
and a DOI-deduplicated note into a chosen Vault. Existing notes are not overwritten.

[Install Paper Clipper in Chrome](#install-paper-clipper-in-chrome) · [Report a Paper Clipper issue](https://github.com/lljh2777-cyber/paper-clipper/issues)

Start with [Paper Agent](docs/paper-agent.md) for the command-line interface,
local Codex Skill, installation instructions, limitations and validation results.

For manual clipping without a local service, use the extension's save menu:
**Download Markdown + images ZIP**. Extract the enclosing folder into your Vault
to keep supported Markdown images beside the note. See
[manual image archives](docs/manual-image-archive.md) for limits and failure handling.
The existing Add to Obsidian and plain Markdown actions do not download images.

For direct translation-ready folders, choose a [default paper directory](docs/default-paper-directory.md)
in extension Settings, then use **Save to default directory**. This creates
`paper.md`, `images/`, `checks.json` and `translation.json` without ZIP extraction and refuses
existing same-name destinations. Directory authorization is local to the browser.

The primary interactive route is now the [usual-browser queue](docs/browser-queue.md):
pair the modified extension once, keep the browser open (the queue page may close), then run
`npm run paper:browser -- "DOI" --download-assets`. Paper tabs are captured and
converted automatically, pausing for human login or verification when needed.
The dedicated Playwright browser and manual HTML inbox remain optional paths.

```sh
npm ci
npx playwright install chromium
npm run build:cli
npm run install:paper-skill
```

This repository preserves the full development baseline and upstream history.
GitHub's contributor listing includes authors of that retained history; it is not
a list of current Paper Clipper maintainers or an endorsement by upstream authors.
Original authorship and commits are preserved, not reassigned.

The development package is named `paper-clipper-dev` and is marked `private: true`
to prevent accidental npm publication (the GitHub repository remains public).
Its inherited version and `obsidian-clipper` CLI alias are retained for build and
command compatibility, not as an official Obsidian product identity.

For a standalone command-line edition without the extension UI, editor, branding
or browser packaging, export the reviewed core file list into a new directory:

```sh
npm run export:core -- -o ../paper-clipper-core
```

Then run `npm install` and `npm test` inside that directory (install Playwright
Chromium first for browser tests). See [the extraction guide](docs/core-extraction.md).
Export refuses an existing destination and never deletes files or copies local
papers, Vaults, browser profiles, build output or installed Skill paths.

[Core CI](docs/core-ci.md) exports and tests the independent edition on Windows
and Linux, with Node.js 22.12 and 24. It uses synthetic tests, not private papers
or logged-in browser profiles. Hosted results are available after the workflow
is pushed and runs in GitHub Actions.

The Chromium development extension now identifies itself as Paper Clipper, with
a document icon, independent project links and explicit upstream attribution.
It is not an official Obsidian release. Upstream copyright and license notices
are retained and bundled. Historical marketing assets and the native Safari
wrapper are not rebranded or part of the Chromium package. A complete release
and dependency-license review remains separate from this UI update.
Third-party components retain their respective licenses.
See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for the development repository
and [Core notices](docs/core/THIRD_PARTY_NOTICES.md) for the exported edition.
Core is the intended basis for a future standalone distribution; no separate
product repository or release is created by exporting it.

Paper captures, personal Vaults, browser profiles and local acceptance samples are
not included. Unit tests use local synthetic fixtures; real-paper acceptance
commands require separately supplied authorized inputs and can fail if those
inputs are absent. See [Real-paper acceptance](docs/paper-acceptance.md).

## Install Paper Clipper in Chrome

From the root of this repository, build the Chrome extension:

```sh
npm ci
npm run build:chrome
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
and select the generated `dist/` folder. Chrome will list the extension as **Paper Clipper**.

## Feedback and contributions

For capture errors, missing figures, or save failures, open a [Paper Clipper issue](https://github.com/lljh2777-cyber/paper-clipper/issues).
Include the public article URL or DOI and what you expected to see. For private pages, omit sensitive content.

To contribute a fix, documentation, or a translation, open a pull request in this repository.
Extension translations are in [src/_locales](src/_locales).

## Developers

For Agent-oriented title/DOI/URL acquisition with one JSON result, start with [Paper Agent](docs/paper-agent.md): `node scripts/save-paper.mjs "<title | DOI | URL>"`. This is a local command, not an installed Agent plugin or MCP server.
To expose that workflow as a discoverable local Codex Skill, use `npm run install:paper-skill`, then invoke `$paper-clipper` on the next turn. See [Skill installation](docs/paper-agent.md#local-codex-skill). No default Vault is configured.
For automatic URL/file/directory routing, start with the [Unified paper command](docs/clip.md): `npm run clip -- <input>`.
For the five-paper support matrix, known limitations, and offline replay, see [Real-paper acceptance](docs/paper-acceptance.md).
For optional offline image attachments, use `--download-assets`; see [Local image attachments](docs/paper-assets.md).
For one-command capture/import, local images and DOI-deduplicated Vault archiving, use `npm run clip -- <input> --download-assets --vault <vault>`; see [Vault archiving](docs/vault-archive.md). Preview already converted files with `npm run clip:vault -- <converted-directory> --vault <vault> --dry-run`.
For one-command paper capture and Markdown validation, see [Paper Clipper](docs/paper-clipper.md).
The standalone HTML capture tool is documented in [Browser Fetcher](docs/browser-fetcher.md).
To export HTML from an already accessible browser tab, see [Extension HTML export](docs/html-export.md).
To automatically pair and batch-convert exported HTML/JSON files, see [Import exported papers](docs/import-papers.md).

### Other browser builds

For cross-browser development, `npm run build` produces `dist/` (Chromium),
`dist_firefox/` (Firefox), and `dist_safari/` (Safari). To test the Firefox build,
open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**,
and select `dist_firefox/manifest.json`. The Xcode project under `xcode/` is the inherited Obsidian Web Clipper simulator wrapper.

### Run tests

```
npm test
```

Or run in watch mode during development:

```
npm run test:watch
```

## Third-party libraries

- [webextension-polyfill](https://github.com/mozilla/webextension-polyfill) for browser compatibility
- [defuddle](https://github.com/kepano/defuddle) for content extraction and Markdown conversion
- [dayjs](https://github.com/iamkun/dayjs) for date parsing and formatting
- [lz-string](https://github.com/pieroxy/lz-string) to compress templates to reduce storage space
- [lucide](https://github.com/lucide-icons/lucide) for icons
- [dompurify](https://github.com/cure53/DOMPurify) for sanitizing HTML

## License

The upstream Obsidian Web Clipper source is licensed under the [MIT License](LICENSE), copyright © 2024 Obsidian.
Upstream trademarks, icons, marketing copy, and other marketing assets are excluded from that license.
See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for attribution and component licenses.
