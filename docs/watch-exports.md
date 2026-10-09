# Browser Export Inbox

Keep authentication in your usual browser. Start the local watcher, then use the
modified Clipper extension's HTML export on a page you can legitimately read.
Place both `paper.html` and `paper.html.json` in a dedicated inbox. The watcher
waits for a stable pair and calls the existing `clip` import/conversion pipeline.
It adds no browser permissions, HTTP server, MCP server, cookie extraction or
login automation. It does not attach Playwright to your everyday browser profile.

## Start

Create an empty dedicated inbox outside your Vault and output directory. In the
project or exported Core directory, after installing and building the CLI:

```sh
npm run build:cli
npm run clip:watch -- "PATH_TO_INBOX" --output-dir "PATH_TO_OUTPUT"
```

For Windows, a possible inbox is `E:\Paper_Clipper\Paper_Inbox`. Do not point this
at your entire Downloads directory: existing pairs in the selected folder are
also processed. Subdirectories and temporary download files are ignored.

Configure the browser to save both export files in this folder, or move the pair
there yourself. Browser save dialogs and multiple-download confirmation may
still require interaction. This command does not change browser preferences.
Avoid renaming the files: the JSON must name its matching HTML exactly.

The watcher stays in the foreground until Ctrl+C. It finishes the current
conversion before stopping. There is no installed background service or automatic
startup. `--once` takes two scans separated by `--settle` (default 1500 ms), then
exits; it may report pending if a file changes during that interval.

## Existing Checks And Optional Archiving

The normal HTML-only validation, sidecar checks, minimum 1000-word threshold,
main-section checks, publisher source-preservation checks, and custom-template
checks remain in force. No PDF/OCR fallback is added. A successful conversion is
not proof of complete publisher full text; completeness, source preservation and
validation coverage retain their independent reported states.

Optional flags are forwarded unchanged:

```sh
npm run clip:watch -- "PATH_TO_INBOX" --output-dir "PATH_TO_OUTPUT" --download-assets --vault "PATH_TO_VAULT" --require-section Results --require-section Methods
```

Image downloads are opt-in and do not receive browser credentials. Inaccessible
images can prevent complete Vault archiving. The existing DOI deduplication,
archive quality checks and note protection are reused. Existing notes and output
Markdown are never overwritten by this command. `--template` is supported, but
must still preserve the required content. An inbox batch has no independently
supplied expected DOI; use the existing `save-paper "DOI" --html ...` route when
you need to compare a capture against a particular requested DOI.

## Results And Retry

Full conversion reports use the existing `_clips` and `_imports` directories.
`<output>/_inbox/state.json` records terminal results. It is bound to this inbox;
use a separate output directory for each inbox. The original exports are retained.
Neither exports, reports nor historical notes are automatically deleted.

Unchanged pairs, including failed or incomplete pairs, are not retried on restart.
Startup labels these as retained history, not fresh validation. Exit codes are
0 for no detected issues, 1 for failures, 2 for incomplete content/assets, and 3
for pending pairs only. Retained failed/incomplete pairs also affect exit status.
Change detection uses file size and filesystem timestamps, not a content hash or
an integrity guarantee. To retry after login or a corrected capture, export a new
timestamped pair. To deliberately rerun an unchanged capture with different
options, use the existing explicit import command and its reports. Do not delete
history just to force a retry. A modified input with an existing output is skipped,
not an instruction to overwrite that output.

Only one watcher may use an output directory. After a forced process termination,
`_inbox/watcher.lock` may remain: first confirm the original process has stopped,
then manually remove that one lock file. Corrupt or mismatched state fails closed
and is not reset. State is limited to 2000 entries / 2 MiB; start a new inbox/output
pair when full. Symlink/junction input and output paths are rejected.

An interruption after output was written but before history was saved is not an
exactly-once transaction. Restart may revisit the pair; existing output and Vault
protections still apply. Keep inbox/output directories private: captured HTML,
metadata, generated notes and reports can contain licensed or personal content.

## Verification Scope

Automated tests use synthetic exports and temporary local directories. They cover
pair stability, restart deduplication, preview rejection through the real converter,
existing-output protection, lock/state handling, cancellation, and path rejection.
The existing pipeline suites cover DOI, templates, images and Vault protection.
They do not prove that a particular browser delivers downloads to the configured
folder, that a publisher permits future access, or that every page is complete.
Actual browser export and any renewed institutional login remain human steps.
