# Browser Fetcher MVP

For the current one-command URL-to-Markdown workflow and the planned extension
HTML export route, start with [Paper Clipper](paper-clipper.md). This document
describes the lower-level browser-only HTML capture tool and its initial results.

Capture a publisher page with a persistent Playwright Chromium session, then feed
the rendered HTML into the existing Clipper CLI. This experiment leaves Defuddle,
the Markdown pipeline, and the extension unchanged.

## Setup

From the repository root, with Node.js 22.12 or newer:

```powershell
npm ci
npx playwright install chromium
npm run build:cli
```

Playwright is a development dependency for this repository script. It is not
included in the published Clipper CLI package.

## First capture with institutional access

```powershell
node scripts/fetch-page.mjs "https://www.nature.com/articles/s41592-025-02899-6" --login -o output/browser-fetch/novae.html
```

The command opens Chromium using `.browser-profile` in this repository. Complete
your school/publisher login in that window, then press Enter in the terminal.
The script revisits the article, waits for stable text, saves the rendered HTML,
and closes the browser. It also closes the browser if capture fails.

This is a dedicated browser profile. It does not inherit a login from your regular
Chrome/Edge window. Cookies and local storage are kept for later runs; session
expiry, MFA, or a VPN requirement can still require intervention. Do not point
`--profile` at a running or everyday Chrome profile, or use the same profile in
concurrent runs. See Playwright's [persistent context documentation](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context).

`.browser-profile/` and `output/browser-fetch/` are ignored by Git. Alternative
paths chosen with `--profile` and `--output` need equivalent local protection.
Captured HTML may contain account-related page content; the profile contains login
state. Neither belongs in commits or shared test fixtures.

## Reuse the session

```powershell
node scripts/fetch-page.mjs "https://www.nature.com/articles/s41592-025-02899-6" -o output/browser-fetch/novae.html
```

Runs are headless by default. `--headed` shows the browser without pausing for
login. `--wait-for "CSS selector"` waits for a known visible article element.
`--timeout 90000` changes each navigation/readiness timeout; `--settle 2500`
requires unchanged article text for 2.5 seconds. Slow pages may need a selector or
longer settling interval. Text stability alone cannot prove all late content has
loaded, and this MVP does not expand collapsed sections or scroll lazy content.

## Convert to Markdown

Only continue after examining the capture report and access state:

```powershell
$capture = Get-Content output/browser-fetch/novae.html.json -Raw | ConvertFrom-Json
node dist/cli.cjs $capture.url --html output/browser-fetch/novae.html -t src/utils/fixtures/templates/minimal.json -o output/browser-fetch/novae.md
```

Use the report's final URL for redirected/proxied pages so relative links resolve
against the page actually captured.

The companion `novae.html.json` records requested/final URLs, title, page word
count, headings, capture time, and a conservative status:

| Exit | Status | Meaning |
| --- | --- | --- |
| 0 | `unchecked` | HTML captured; full-text completeness has not been established. |
| 1 | Error | Navigation, readiness, login prompt, or writing failed. |
| 2 | `subscription-preview` | A visible subscription-preview notice was detected. HTML is retained for diagnosis. |

The preview check currently recognizes "This is a preview of subscription
content". Absence of that notice is not proof of full text: other publishers,
login pages, and bot challenges can use different wording. A failed capture does
not overwrite an earlier HTML file; check the exit code before reusing output.

## Novae acceptance check

The handoff conversation reported about 2,327 words from anonymous CLI fetch and
12,619 words from the manual extension. Treat those as prior measurements, not a
new test result. Compare the Markdown body after removing YAML frontmatter:

- No subscription preview notice.
- Main, Results, Discussion, Methods, and References are present.
- Substantial body content and figure captions match the manual reference.
- Body length is close to the approximately 12,619-word reference; inspect any gap.

Authentication must be established before claiming this real-paper regression
passed. Automated local tests establish the browser-to-CLI mechanism only.

## Tests

```powershell
npm run test:browser-fetch
```

The tests use a local HTTP fixture and real Chromium. They verify persistent
cookies across separate browser launches, delayed JavaScript rendering, redirects,
preview diagnostics, error cleanup, and conversion through `dist/cli.cjs --html`.
An additional synthetic test launches and awaits separate Node CLI processes:
fixture login, two cold captures, an empty-profile negative control, and server
revocation. Both a persistent HttpOnly cookie and localStorage are required for
that fixture's body; sessionStorage from the login window must not carry over.
No real accounts, publisher HTML, regular-browser cookies or network publishers
are involved. This establishes persistence mechanics, not any SSO entitlement.
Test profiles and captures remain in the ignored `output/browser-fetch/tests/`
directory. They are not recursively deleted.

## Scope

This milestone does not add title/DOI lookup, MCP/Agent tools, automatic Vault
writes, PDF conversion, or a universal paper-completeness classifier.

## Initial fetcher milestone: 2026-10-07

Implemented and locally verified on Windows with Node.js 24.18.0 and Playwright
1.63.0. The CLI build passed, and all four Browser Fetcher tests passed.
The existing API test also passed. Running the existing template integration
suite produced six fixture failures caused by CRLF/LF differences, with an
additional local-timezone difference in the YouTube fixture; it also logged
jsdom/linkedom Element compatibility warnings. That initial fetcher milestone did
not change files under `src/`; the later HTML export milestone does.

The real Novae capture in the new profile still has no full-text authorization:

| Source | Markdown body words | Access result |
| --- | ---: | --- |
| Existing `test-paper2.md` | 2,311 | Subscription preview |
| Browser Fetcher + CLI | 2,302 | Subscription preview |
| Manual extension reference | 12,619 | Main, Results, Discussion, Methods present |

Counts above strip YAML frontmatter and split the remaining body on whitespace.
Local diagnostic artifacts are `output/browser-fetch/novae.html`,
`novae.html.json`, `novae-preview.md`, and `novae-reference.md`. The report correctly
flags `subscription-preview`; this real-paper acceptance check has not passed.

The user confirmed that their everyday browser can still read the full paper.
The original plan was to establish equivalent authorization in the dedicated
profile and compare with the manual reference. Reading existing Chrome tabs through
the available browser connector failed during this session. The updated plan is
to finish the accessible-URL pipeline first, then add HTML export to the existing
Clipper extension so it can use the current tab's access rights. Do not assume the
new profile inherits the everyday browser's login or declare the preview a full
paper. No subscription purchase is part of this workflow.

Both routes are now implemented. See [Paper Clipper](paper-clipper.md) and
[Extension HTML export](html-export.md). The later authorized Novae snapshot
passed that comparison: after math normalization, its Markdown body matches the
12,619-word manual reference exactly. The dedicated browser profile's earlier
capture remains a preview and has not gained that authorization.

## Explicit local cold-start acceptance: 2026-10-09

The initial fresh-process capture with the dedicated profile still returned a
subscription preview. The user then manually logged in through the visible
Chromium window and confirmed the Novae body was readable. The existing
`--login` command revisited the article, captured it and closed the context and
Node process. A separate headless CLI invocation reused the same profile without
`--login`. It retained access to DOI `10.1038/s41592-025-02899-6`.

Both captures were explicitly converted locally through the unchanged
Clipper/Defuddle path with expected DOI verification and required Main, Results,
Discussion and Methods sections. Results:

- Publisher DOI matched; main-section prose: 11,174 words.
- Six supported legends and 33 ordinary source paragraphs matched.
- Sixteen math-containing paragraphs were skipped by the plain-prose comparator.
- Warm/cold Markdown bodies were byte-identical after removing YAML frontmatter.
- Existing reference comparison passed with its already-declared six legend
  additions; no reference or tolerance was changed. Output has 13,695 body words,
  69 math expressions, seven display equations, six images and 59 footnote definitions.

This verifies immediate process/browser restart on this Windows machine only.
It does not establish overnight expiry, machine reboot, SSO/MFA renewal, another
network or another computer, nor visual/semantic correctness of every formula.
No images were downloaded during this acceptance and no Vault was modified.
Private captures remain under ignored `output/session-audit/`; the profile and
HTML are not distributed as fixtures or CI artifacts.

For a repeat, run these in separate interactive terminal invocations, choosing a
fresh output folder to preserve earlier evidence:

```powershell
node scripts/fetch-page.mjs "https://www.nature.com/articles/s41592-025-02899-6" --profile .browser-profile --login -o output/session-audit/recheck/manual.html
# Wait until the first command exits and its browser closes.
node scripts/fetch-page.mjs "https://www.nature.com/articles/s41592-025-02899-6" --profile .browser-profile -o output/session-audit/recheck/cold.html
```

`unchecked` only means capture succeeded. Inspect access state and run conversion
checks before accepting the result; the local `clipPaper` API accepts
`expectedDoi` in addition to the usual required sections. Stop on a preview or
CAPTCHA and request human login or an authorized HTML export, never copy the
regular browser's cookies or automate challenge solving. Re-authentication is
expected when the publisher expires or revokes a session.
