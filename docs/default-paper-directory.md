# Default Paper Directory

Optional [supplementary file selection](paper-attachments.md) adds checked files
to `supplements/` using the same rules as ZIP. Existing archives and translations
remain protected; attachment failure prevents creating a new output directory.

Use [Archives](paper-library.md) from the extension or Settings to search the
authorized root's recorded papers without opening or changing notes/translations.

In the updated extension, open Settings > General > Behavior. Use the folder
icon beside **Default paper directory** to choose a local directory such as
`E:\Literature_translation` and grant access. Optionally set **Save behavior**
to **Save to default directory** to make this the main button. Otherwise the
same command is available in the save menu. ZIP is a separate output format on
the same background-save path. Plain Markdown and Add to Obsidian are unchanged.

The selected directory is an extension-local File System Access handle stored
in IndexedDB, not a typed absolute path and not a synced setting. The browser
may ask for permission again after a restart, revocation or browser policy
change. Re-selecting the folder restores access. Forgetting the directory only
clears this preference and never deletes files. Browsers without a directory
picker can continue to use ZIP export. This does not change the browser's global
Downloads location. Only the directory name can be displayed, not its full path.

### Background Saving

Saving from the popup, sidebar or embedded Clipper (including the reader) opens
a background **Paper Clipper | Save** tab without switching away from the article.
It receives the current edited Markdown,
title, frontmatter and explicit identity, without extracting the page again.
It saves automatically when the chosen directory already has write permission,
then closes itself after all files and completion metadata have been written,
unless the saved result needs review. Missing permission, a missing directory,
duplicate-archive choices, a save error or a saved-result warning activates the tab.
If permission needs renewing, click **Authorize and save** there. If no directory
is configured, select one there. Closing the originating popup does not stop
image preparation or file writes after the handoff.
This respects Chromium's cross-origin iframe restrictions on filesystem prompts;
changing a manifest permission or repeatedly selecting the same folder in an
iframe cannot fix that boundary.

The editor first reports background saving, then receives progress and the actual
outcome, including the scoped content-check summary. A completed save with content
differences or preferred-image fallbacks stays visible as **Saved, but review is
needed**. It lists the affected checks by extraction/template/output stage and
matched counts, without treating intentional edits as proven conversion errors.
It does not offer retry after a completed save. The warning also remains in the
editor's last result and `checks.json`. Missing coverage does not itself block or
activate a save, and is never described as verified completeness. Ordinary
success has no focus change, even if you switch tabs while saving. Closing the
editor does not cancel the independent save. Keep the save tab open while it
works; it closes automatically on ordinary success. Closing it while
waiting for authorization cancels without writing. Reloading
or duplicating it never automatically repeats the save: start again from the
editor, whose contents remain unchanged. Closing it mid-write can leave partial
output, under the same protection rules below. If it closes without a completion
message, the editor reports an unconfirmed result, never a false success. A
specific known failure remains visible even after the failed save page closes.
Reopening the editor shows the last terminal result in this browser session,
labelled **Last save result**, not as a result for the current article.

Image download failures offer **Retry save** in the save page. This uses the
same edited snapshot and runs only on an explicit click; no output directory
was created before that failure. Unsupported images and size limits require
review in the editor instead. Partial writes, existing directories and unknown
outcomes do not offer blind retries. Inspect the named folder before a new
save; the tool never deletes or overwrites it to make a retry succeed.

There is no new server, pairing or external message endpoint. A single pending snapshot is
kept in trusted extension **session** storage, never synced; only a random request
ID appears in the tab URL. The save page is not web-accessible. It consumes and
removes the snapshot before filesystem work, then keeps it in page memory. An
unopened request expires after one minute and is discarded on the next request
or when the browser session ends. Session-storage quota errors are reported as
handoff failures, not folder-permission failures; the editor and ZIP route remain
available. No browser credentials or personal files are read for the handoff.
Status-only runtime notifications are accepted only from the matching extension
save page and request ID. They carry no article HTML or Markdown, and do not
persist a second copy of the snapshot. Only one terminal status message is kept
in session storage, without article contents or image URLs; it is not a durable
history or an automatic resume queue.

## Output

```text
E:\Literature_translation\
  2025_Novae__10.1038_s41592-025-02899-6\
    paper.md
    checks.json
    images\
      image-1.png
    translation.json
```

The name uses the publication year, a Windows-safe short title, and a sanitized
DOI. Missing years become `unknown`; missing DOI values use an internal UUID.
DOI metadata is taken from explicit page metadata, the editor's DOI property or
a doi.org URL, never inferred from prose. Conflicting explicit DOI values abort
the save. The exact DOI is retained in `translation.json`. This is not a registry
lookup or verification of article identity/completeness.

`paper.md` preserves the current editor contents and frontmatter, with the same
image downloading and localization as ZIP export. Both future language versions
can share `images/`. No empty Chinese file is created. `translation.json` names
`paper.zh-CN.md` as the future output and records `not-started`, an English-source
SHA-256 fingerprint, image count, provenance and separate acquisition,
translation-check and human-review states. Acquisition preservation/coverage
match the shared [manual export report](manual-image-archive.md#export-checks)
in `checks.json`; full-text completeness remains unassessed. No translation is
performed and no existing paper is rewritten to add a report.

## Protection And Limits

- Keep the browser and independent save tab open until saving finishes. The
  originating popup/sidebar can close once it reports background saving.
- All images must be prepared successfully before creating any output files.
  The [ZIP image limits](manual-image-archive.md#limits) still apply.
- Existing same-name directories/files and same-DOI archives require a choice:
  **Keep existing** skips this save, without claiming the old archive is complete;
  **Save a new version** creates a separate `__v_<UUID>` directory. Neither option
  changes old Markdown, translations, annotations, images or metadata. A new
  version starts untranslated and records the matching previous directory names.
- DOI matching reads only immediate child `translation.json` files (schema 1,
  `sourceFile: paper.md`), normalizing DOI case, URL and `doi:` prefixes. Renaming
  the title, year or directory does not hide a matching DOI. Partial archives are
  also protected. Missing DOI values are not inferred from titles or notes.
  There is no recursive search or Markdown/translation read; nested archives,
  metadata-free notes and ZIP files are outside this check. Corrupt, oversized
  (over 128 KiB) or unreadable metadata is reported without proceeding blindly.
  Core's separate Vault deduplication remains unchanged.
- Writes from extension pages are serialized with Web Locks. Avoid concurrent
  external changes to the destination while saving. File System Access has no
  atomic multi-file directory commit or exclusive directory-create operation.
- A metadata marker starts as `writing` and becomes `complete` only after images
  and the English file close successfully. Disk/permission failures may leave a
  recoverable partial directory, marked `failed` when metadata can still be
  written. The error names the directory; no success is reported.
- Directory permission only covers the selected folder. No local server,
  browser Cookie reading, or personal-Vault migration is added. ZIP separately
  requests optional browser download permission to confirm completion.

## Verification

Unit tests cover names, conflicting/missing DOI, permission denial, existing
paper/translation protection, normalized DOI duplicates despite renamed folders,
explicit new versions, write-lock duplicate rechecks, corrupt metadata,
image failure before writes and disk failure. Completed-save warnings cover
content differences and image fallback separately from missing coverage.
Chromium E2E uses a synthetic picker returning a real isolated OPFS handle:
settings reload and handle persistence, main-button saving, actual file/image
bytes, metadata, collision refusal, forgetting without deletion, and desktop/
narrow settings layout. It never grants access to personal folders. The native
OS picker, real external-folder grants and permission persistence after browser
restart require manual acceptance. Firefox/Safari direct-folder writes are not
validated; neither are Firefox/Safari confirmed ZIP downloads.

The embedded regression uses a real cross-origin extension iframe, and forbids
filesystem permission calls from that frame. It covers edited snapshot handoff,
background saving without activation, success auto-close and editor feedback,
permission/error activation, simulated prompt/denial followed by a
real button click, reload without replay, existing-file
protection, and narrow/desktop save-page layout. Permission simulation over OPFS
does not prove native external-directory permission persistence. Unit tests also
cover single-consumption/concurrent claims (including snapshots without a DOI),
expiry, failed tab launches and session-quota failures. These tests use synthetic
content and isolated profiles. The ordinary-popup regression closes the editor
while image preparation is pending, then verifies completed files and restored
feedback. Unit tests exercise failure retention, explicit safe retry of the
unchanged snapshot, and refusal to retry partial writes.
