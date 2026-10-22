# Selected Supplementary Files

Reload the extension and refresh the article. In the editor footer, expand
**Supplementary files (ZIP / directory)** and check the files to include before
choosing **Download Markdown + images ZIP** or **Save to default directory**.
Everything starts unchecked. Changing the captured page/template resets the
selection. No attachment requests occur while listing or selecting files.

The list uses explicit links in the captured page, with supplementary/supporting
information, source data or numbered supplementary-table evidence. It does not
list every link, crawl landing pages, guess file addresses, or select the main
article PDF. Discovery is bounded to 50 unique candidates. No candidates means
no picker, not proof that the article has no supplements.

Supported direct HTTPS links end in `.pdf`, `.csv`, `.tsv`, `.txt`, `.xlsx`,
`.docx` or `.zip`. Download endpoints without a recognized suffix, legacy Office
formats, video and executable files are not included in this first version.

## Output And Protection

The existing `year_short-title__DOI` bundle gains `supplements/` and
`supplement-report.json` only when files were selected. The report records each
file's display label, local filename, byte count and SHA-256; it omits source
URLs so signed query parameters are not copied into a new receipt. Matching
Markdown links become relative links to the downloaded files. Other links,
frontmatter and unused reference definitions are unchanged and may remain online.
If extraction or editing removed a link, the selected file is still available in
`supplements/` and its receipt; saving does not insert extra prose into the note.

`checks.json` records attachment count and the limited HTTP/type/signature scope
separately from article completeness, preservation and verification coverage.
`translation.json` points to the attachment report. Both reports hash the final
localized `paper.md` consistently. Supplementary PDFs are opaque attachments;
they never replace the HTML article or trigger PDF extraction/OCR.

All selected files must download and pass basic checks before any ZIP is
published or output directory is created. A failure reports its selection number
and reason, without signed URLs. Transient network errors allow an explicit retry
of the original selection, including after closing the editor. Access denial,
unsupported formats and size limits require reviewing the selection, not blind
retries. Directory-write failures still leave a marked failed archive; existing
DOI archives, translations and user files are never overwritten. Creating a new
version remains an explicit action. ZIP extraction must still avoid merging with
an existing translated folder.

## Limits And Safety

- Maximum 20 selected files, 50 MiB per file, 100 MiB total attachment bytes,
  and 30 seconds per request. These limits are additional to existing image limits.
- No browser cookies or referrer; redirects, embedded credentials, literal IPs,
  local hostnames and non-HTTPS URLs are rejected. Signed URLs are used intact.
  Authentication-only or redirecting files can fail even on a logged-in page.
  Browser network protections apply; this path does not implement DNS pinning.
- HTTP responses, declared types and basic signatures are checked. Text files
  must be UTF-8. Obvious HTML/login responses are rejected.
- PDF and ZIP/Office contents are not parsed, executed, unpacked or virus-scanned.
  `contentSafety: not-assessed` is intentional. Download only trusted material;
  a valid file signature is not proof that opening it is safe.
- No change to plain Markdown downloads, Add to Obsidian, CLI/queue acquisition,
  existing archives, browser login state or content-quality thresholds.

## Verification

Public synthetic fixtures cover discovery/exclusions, unchecked defaults,
capture-bound selections, credential-free requests, duplicate URLs, redacted
receipts, type/access/size failures, local links, ZIP/directory parity, source
hashes and existing DOI/translation protection. Hosted Chromium exercises the
real picker and ZIP download, no-selection/no-fetch behavior, failure without a
partial ZIP, and retry after closing the editor, with desktop/narrow screenshots.
Native permission prompts and real publisher attachment availability remain
manual acceptance; private authorized HTML is not used in CI.
