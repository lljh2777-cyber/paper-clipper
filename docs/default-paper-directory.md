# Default Paper Directory

In the updated extension, open Settings > General > Behavior. Use the folder
icon beside **Default paper directory** to choose a local directory such as
`E:\Literature_translation` and grant access. Optionally set **Save behavior**
to **Save to default directory** to make this the main button. Otherwise the
same command is available in the save menu. ZIP and plain Markdown downloads
and Add to Obsidian remain separate, unchanged operations.

The selected directory is an extension-local File System Access handle stored
in IndexedDB, not a typed absolute path and not a synced setting. The browser
may ask for permission again after a restart, revocation or browser policy
change. Re-selecting the folder restores access. Forgetting the directory only
clears this preference and never deletes files. Browsers without a directory
picker can continue to use ZIP export. This does not change the browser's global
Downloads location. Only the directory name can be displayed, not its full path.

## Output

```text
E:\Literature_translation\
  2025_Novae__10.1038_s41592-025-02899-6\
    paper.md
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
SHA-256 fingerprint, image count, provenance and separate unassessed acquisition,
translation-check and human-review states. No translation is performed.

## Protection And Limits

- Keep the extension popup/sidebar open until saving finishes.
- All images must be prepared successfully before creating any output files.
  The [ZIP image limits](manual-image-archive.md#limits) still apply.
- Existing same-name directories or files are refused, including partial output
  from an earlier failed save. Nothing is overwritten or recursively deleted.
  This manual route does not scan other folders for DOI duplicates; differently
  named copies can exist. Core's separate Vault deduplication remains unchanged.
- Writes from extension pages are serialized with Web Locks. Avoid concurrent
  external changes to the destination while saving. File System Access has no
  atomic multi-file directory commit or exclusive directory-create operation.
- A metadata marker starts as `writing` and becomes `complete` only after images
  and the English file close successfully. Disk/permission failures may leave a
  recoverable partial directory, marked `failed` when metadata can still be
  written. The error names the directory; no success is reported.
- The permission only covers the selected folder. No local server, new manifest
  permission, browser Cookie reading, or personal-Vault migration is added.

## Verification

Unit tests cover names, conflicting/missing DOI, permission denial, existing
paper/translation protection, image failure before writes and disk failure.
Chromium E2E uses a synthetic picker returning a real isolated OPFS handle:
settings reload and handle persistence, main-button saving, actual file/image
bytes, metadata, collision refusal, forgetting without deletion, and desktop/
narrow settings layout. It never grants access to personal folders. The native
OS picker, real external-folder grants and permission persistence after browser
restart require manual acceptance. Firefox/Safari direct-folder writes are not
validated; ZIP remains available.
