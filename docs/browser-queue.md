# Usual Browser As The Primary Route

Use the modified extension in your usual Chrome/Edge browser to acquire papers.
Its normal login stays in that browser. The dedicated Playwright browser remains
optional; this route never silently falls back to it. This first implementation
supports Chromium extensions only.

## First Setup

Build/update the development extension in the full checkout (not exported Core):

```sh
npx webpack --env BROWSER=chrome --env SKIP_CLEANUP=true --mode development
```

Load/reload the resulting `dev` directory in Chrome's extension manager. This is
a local development build, not an official Obsidian release or a distributable
rebranded package. Existing loaded builds pointing at `dist` will not acquire
the new queue until you load the updated directory. Keep only the intended custom
build enabled to avoid confusing it with the official extension.

From either the full checkout or exported Core, build the CLI and start a queue:

```sh
npm run build:cli
node scripts/browser-queue.mjs "10.1038/s41592-025-02899-6" --download-assets
```

Open **Paper queue** (clipboard-list icon) in the extension popup or sidebar.
The terminal hides the key by default. For first pairing, explicitly view it in
another terminal (add the same `--output-dir` if customized):

```sh
node scripts/browser-queue.mjs --show-pairing-key
```

This reads an existing key without starting a queue or creating one. Alternatively,
add `--show-pairing-key` when starting a queue to opt into printing it.
Enter the loopback endpoint and private pairing key in the extension,
then Connect. The key is kept in extension **local**, not sync, storage and in
`<output-dir>/pairing-key.txt`. Do not share it, screenshot it, or commit it.
On Windows this file inherits the output directory's ACL: keep that directory
private to your OS user. Forget pairing clears the extension copy only.

### Reset An Exposed Key

After updating, restart the local service and reload the development extension.
In the paired queue page, click **Reset pairing** and confirm. The service replaces
its key, updates this controller, and rejects the old key. Other controllers must
re-pair. Claimed captures pause and require explicit Resume; a conversion already
in progress blocks reset until it finishes. Saved notes and publisher login are
unchanged. Use only one service per output directory, even on different ports.

Updating code alone does not rotate an exposed key. Old terminal output or shared
screenshots remain visible, so explicitly reset it. If the reset response is lost,
view the current key explicitly and reconnect; do not retry blindly. Pairing files
and any temporary key files are private local data. **Forget pairing** is not a
server-key reset.

Keep this queue page and the local command open. The page is a foreground task
controller, not an always-running background service. Closing it stops acquisition;
it does not erase publisher login. On reopening it remembers pairing. There is no
need to click Export or choose a download folder for each paper. The old manual
export/inbox watcher remains a separate fallback.

## Subsequent Queues

```sh
node scripts/browser-queue.mjs "DOI_ONE" "https://publisher.example/article" --download-assets
node scripts/browser-queue.mjs "DOI" --download-assets --vault "EXPLICIT_VAULT_PATH"
```

Use the same output directory and port to reuse pairing. A command accepts 1-20
DOIs, URLs or full titles; title ambiguity requires a confirmed DOI, not selection
by rank. The command stays open until Ctrl+C, including after all tasks finish.
Stop it before starting the next queue on the same port. Only one controller
page may claim tasks at once.

The extension creates one task tab at a time and waits for a stable DOM. Readiness
is not proof of completeness. The existing export sanitizer snapshots HTML for
the paired loopback service, without browser save dialogs. The existing
save/import/convert/archive chain enforces DOI or URL identity, content thresholds,
supported preservation checks, images and Vault protection. Custom templates via
`--template` pass those same checks. No overwrite, threshold reduction, cookie
extraction, debugger attachment, PDF or OCR is added.

The terminal prints per-paper status and a queue report path. That report contains
conversion reports, independent completeness/preservation/coverage states,
output paths and candidates. Saved is not proof of scientific equivalence.
Captures and reports are retained locally, not uploaded.

## Human Attention And Recovery

Login, CAPTCHA, preview content, unstable pages and incomplete conversions pause
the queue. Use Open task tab, complete authorized access yourself, then Resume
after review. Resume is an explicit new attempt and invalidates the old claim.
Skip cancels the task. Failed or ambiguous tasks are never automatically retried.

Accepted task tabs close only if still at the observed/captured URL. Tabs the user
navigates elsewhere are left alone. Everyday tabs are not enumerated, reused or
closed. On controller reload it intentionally forgets tab IDs so it cannot close
an unrelated reused tab. A claimed job then requires explicit Resume/Skip; Resume
creates a new task tab. Close the old tab yourself after checking it. This also
applies after a browser/process crash.

Task state is reported for the current command, not automatically resumed across
server restarts. Restarting the same identifiers is an explicit new queue. Pairing
and browser login persist, but captures are new attempts. Repeated saves without
a Vault can create separate outputs. Vault DOI deduplication still protects notes.
After uncertain network interruption, inspect the report before a new attempt:
the server may have finished conversion.

## Boundary And Verification

The service binds **127.0.0.1 only**, requires a 256-bit bearer key for all job
operations, checks Host and extension Origin, and exposes no browser-accessible
enqueue or filesystem-path API. Jobs and output options come from the explicit
local command, never page DOM/messages. No manifest permissions are added.
Pairing grants the extension access to this queue; keep that build trusted.

Tests use synthetic captures and local fixture pages only. They do not prove
institution-specific SSO, CAPTCHA, VPN/proxy redirects, session expiry,
background-tab throttling or Firefox/Safari support. Private Novae acceptance
requires the user's authorized browser and deliberate local execution.
Image requests have no browser credentials; session-only images may remain
incomplete and block Vault archiving.

The optional dedicated route remains unchanged:

```sh
node scripts/save-paper.mjs "DOI" --fetch browser --login --download-assets
```

`save-paper.mjs` retains its machine JSON interface and defaults for compatibility.
`browser-queue.mjs` / `npm run paper:browser` is the primary usual-browser workflow;
no silently changed default affects existing jobs. Exported Core contains the
local queue service, not the separately installed extension UI or branding.
