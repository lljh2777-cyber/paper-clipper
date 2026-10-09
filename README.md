# Paper Clipper

An independent, unofficial paper-acquisition workflow based on
[Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper).
Resolve a title, DOI or URL, obtain accessible publisher HTML, convert it to
Markdown, check supported content structures, and optionally archive local images
and a DOI-deduplicated note into a chosen Vault. Existing notes are not overwritten.

Start with [Paper Agent](docs/paper-agent.md) for the command-line interface,
local Codex Skill, installation instructions, limitations and validation results.

The primary interactive route is now the [usual-browser queue](docs/browser-queue.md):
pair the modified extension once, keep its Paper queue page open, then run
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

It is not an official Obsidian release or a distribution-ready rebranded browser
extension. Upstream copyright and license notices are retained. Brand assets,
icons and marketing materials are excluded from upstream's MIT grant; review and
replace or separately license those materials before packaging a derived release.
Third-party components retain their respective licenses.
See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for the development repository
and [Core notices](docs/core/THIRD_PARTY_NOTICES.md) for the exported edition.
Core is the intended basis for a future standalone distribution; no separate
product repository or release is created by exporting it.

Paper captures, personal Vaults, browser profiles and local acceptance samples are
not included. Unit tests use local synthetic fixtures; real-paper acceptance
commands require separately supplied authorized inputs and can fail if those
inputs are absent. See [Real-paper acceptance](docs/paper-acceptance.md).

## Upstream Documentation

The following describes the upstream project. Links to official extension stores
install the upstream extension, not the custom HTML-export build in this fork.

Obsidian Web Clipper helps you highlight and capture the web in your favorite browser. Anything you save is stored as durable Markdown files that you can read offline, and preserve for the long term.

- **[Download Web Clipper](https://obsidian.md/clipper)**
- **[Documentation](https://help.obsidian.md/web-clipper)**
- **[Troubleshooting](https://help.obsidian.md/web-clipper/troubleshoot)**

## Get started

Install the extension by downloading it from the official directory for your browser:

- **[Chrome Web Store](https://chromewebstore.google.com/detail/obsidian-web-clipper/cnjifjpddelmedmihgijeibhnjfabmlf)** for Chrome, Brave, Arc, Orion, and other Chromium-based browsers.
- **[Firefox Add-Ons](https://addons.mozilla.org/en-US/firefox/addon/web-clipper-obsidian/)** for Firefox and Firefox Mobile.
- **[Safari Extensions](https://apps.apple.com/us/app/obsidian-web-clipper/id6720708363)** for macOS, iOS, and iPadOS.
- **[Edge Add-Ons](https://microsoftedge.microsoft.com/addons/detail/obsidian-web-clipper/eigdjhmgnaaeaonimdklocfekkaanfme)** for Microsoft Edge.

## Use the extension

Documentation is available on the [Obsidian Help site](https://help.obsidian.md/web-clipper), which covers how to use [highlighting](https://help.obsidian.md/web-clipper/highlight), [templates](https://help.obsidian.md/web-clipper/templates), [variables](https://help.obsidian.md/web-clipper/variables), [filters](https://help.obsidian.md/web-clipper/filters), and more.

## Contribute

### Documentation

User documentation is maintained in the [`en/Obsidian Web Clipper` directory of obsidian-help](https://github.com/obsidianmd/obsidian-help/tree/master/en/Obsidian%20Web%20Clipper).

### Translations

You can help translate Web Clipper into your language. Submit your translation via pull request using the format found in the [/_locales](/src/_locales) folder.

### Features and bug fixes

See the [help wanted](https://github.com/obsidianmd/obsidian-clipper/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) tag for issues where contributions are welcome.

## Roadmap

In no particular order:

- [ ] Annotate highlights
- [ ] Template directory
- [ ] Sync settings across browsers
- [x] A separate icon for Web Clipper (1.6.3)
- [x] Template validation (1.1.0)
- [x] Template logic (if/for)  (1.1.0)
- [x] Save images locally ([Obsidian 1.8.0](https://obsidian.md/changelog/2024-12-18-desktop-v1.8.0/))
- [x] Translate UI into more languages — help is welcomed

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

To build the extension:

```
npm run build
```

This will create three directories:
- `dist/` for the Chromium version
- `dist_firefox/` for the Firefox version
- `dist_safari/` for the Safari version

### Install the extension locally

For Chromium browsers, such as Chrome, Brave, Edge, and Arc:

1. Open your browser and navigate to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `dist` directory

For Firefox:

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Navigate to the `dist_firefox` directory and select the `manifest.json` file

If you want to run the extension permanently you can do so with the Nightly or Developer versions of Firefox.

1. Type `about:config` in the URL bar
2. In the Search box type `xpinstall.signatures.required`
3. Double-click the preference, or right-click and select "Toggle", to set it to `false`.
4. Go to `about:addons` > gear icon > **Install Add-on From File…**

For iOS Simulator testing on macOS:

1. Run `npm run build` to build the extension
2. Open `xcode/Obsidian Web Clipper/Obsidian Web Clipper.xcodeproj` in Xcode
3. Select the **Obsidian Web Clipper (iOS)** scheme from the scheme selector
4. Choose an iOS Simulator device and click **Run** to build and launch the app
5. Once the app is running on the simulator, open **Safari**
6. Navigate to a webpage and tap the **Extensions** button in Safari to access the Web Clipper extension

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

Obsidian Web Clipper source code is open source under the MIT License. All trademarks, icons, marketing copy, and other marketing assets are excluded from that license.
