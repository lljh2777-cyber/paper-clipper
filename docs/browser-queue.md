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
a local Paper Clipper development build, not an official Obsidian release.
It uses its own name and document icon, with upstream attribution in settings.
Reload the existing `dev` installation in place after updating; do not remove and
reinstall it just to refresh branding, as removal clears extension-local data.
The Chrome build retains its permissions, storage keys and loading path, so an
in-place reload retains pairing and settings. It may pause an interrupted task;
finish or review active tasks before reloading. Existing builds pointing at `dist` will not acquire
the new queue until you load the updated directory. Keep only the intended custom
build enabled to avoid confusing it with the official extension.

From either the full checkout or exported Core, build the CLI and start a queue:

```sh
npm run build:cli
node scripts/browser-queue.mjs "10.1038/s41592-025-02899-6" --download-assets
```

Open **Paper queue** (clipboard-list icon) in the extension popup or sidebar.
Click **Connect**. The default address is already filled. Compare the 6-digit
confirmation code in the extension with the request printed in the local terminal,
then enter that code in the terminal and press Enter. The extension receives and
remembers the private key automatically; no second terminal or key copying is
needed. To refuse a request, enter `deny CODE`. Do not approve an unexpected request.

Requests expire after two minutes and grants can be collected only once by the
requesting client. Approval has no HTTP endpoint. Other requests cannot replace
an outstanding request. The code verifies the request; it is not the pairing key.
Keep the queue page open until the initial confirmation finishes. Existing pairing
is reused on subsequent connections without another code.

Automatic pairing requires interactive terminal input (TTY). An Agent may start
the queue in a PTY, but must obtain explicit human confirmation of the displayed
request before entering its code. It must not automatically approve requests.
Noninteractive services reject new automatic pairings; already-paired acquisition
works normally. No additional browser permission is needed for this change.

### Advanced Manual Pairing

For custom ports, expand **Advanced** and edit Local endpoint. Manual keys remain
an explicit fallback for older/noninteractive services. To view an existing key
(add the same `--output-dir` if customized):

```sh
node scripts/browser-queue.mjs --show-pairing-key
```

This reads an existing key without starting a queue or creating one. Alternatively,
add `--show-pairing-key` when starting a queue to opt into printing it.
Enter it under **Advanced > Manual pairing key**, then Connect.
The key is kept in extension **local**, not sync, storage and in
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
request a new locally confirmed pairing or use Advanced; do not retry blindly. Pairing files
and any temporary key files are private local data. **Forget pairing** is not a
server-key reset.

Keep the browser and local command running. **The queue page can be closed**:
the extension background worker owns acquisition; pages only show state and
provide controls. Pairing and the enabled/disconnected choice persist locally.
Disconnect disables background acquisition until Connect is clicked again.
Closing a view is not Disconnect and does not erase publisher login. There is no
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
Stop it before starting the next queue on the same port. Multiple queue views
share one background controller; they do not claim tasks independently.

The worker uses an `alarms` permission to check for new queues about once per
minute, with short follow-up checks during an active batch. It recreates missing
alarms on worker/browser startup. Browser/device sleep can delay this schedule;
the extension does not keep Chrome alive or wake the computer. No notifications,
cookies, debugger or additional host permissions are requested. To inspect a
pause, open Paper queue from the extension. Login/CAPTCHA never auto-resumes.

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
closed. Task-tab ownership is stored in browser-session storage, so a terminated
worker can resume its own capture without scanning everyday tabs. The durable
local journal records only job ID, lease and phase, never HTML or browser cookies.
Browser restart or extension reload clears session-owned tab IDs: an interrupted
capture then pauses for explicit Resume/Skip instead of adopting possibly reused
IDs. Close any restored old task tab yourself after checking it. Pending queued
work can start automatically after browser restart when background acquisition
remains enabled and the local service is still running.

Before sending HTML the worker journals the submitting phase. If the response is
lost or exceeds 20 seconds, it checks the server's processing/terminal status;
it never automatically resends HTML. An uncertain submission still marked claimed
is paused for explicit review. Conversion runs locally and is not cancelled by
closing a queue view or terminating the extension worker.

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
local command, never page DOM/messages. Background control messages are accepted
only from this extension's exact queue page, never publisher content scripts.
Initial pairing endpoints accept only bounded JSON with a 256-bit requester nonce,
check browser origins and extension identity when Origin is present, and require
local human approval before releasing a key. They never expose jobs or approval
over HTTP. Local OS processes can construct headers and are not isolated by CORS;
keep the key directory private and approve only a matching request you initiated.
Pairing grants the extension access to this queue; keep that build trusted.

Tests use synthetic captures and local fixture pages only. They do not prove
institution-specific SSO, CAPTCHA, VPN/proxy redirects, session expiry,
real device suspend timing, background-tab throttling or Firefox/Safari support.
Synthetic end-to-end tests close every queue view, stop the Chromium worker and
wait for alarm-based recovery; fault-injection tests cover uncertain submissions,
lost ownership, disabled startup and blocked access. Private Novae acceptance
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
