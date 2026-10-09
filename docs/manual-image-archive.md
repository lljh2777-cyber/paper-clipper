# Manual Markdown And Image ZIP

Reload the updated extension, open a paper, and open Paper Clipper. Review or
edit the note, then use the arrow next to **Add to Obsidian** and choose
**Download Markdown + images ZIP**. Keep the popup or sidebar open until the
download starts. No local service, pairing key or Vault permission is needed.

Extract the ZIP into your Vault. Keep its enclosing `paper-<unique-id>` folder:
it contains `paper.md` and an `images/` directory. The unique folder prevents
attachment collisions between papers. Rename the note if desired, keeping it
next to `images/`. Extraction itself is performed by you, not by the extension.

This command archives the **current editor contents**, not a newly fetched
article. It preserves frontmatter, prose and captions, downloads inline and
reference-style Markdown images, and rewrites their displayed references to
relative local paths. Repeated URLs are downloaded once. Unused reference
definitions, ordinary hyperlinks and frontmatter values remain unchanged.
It does not prove article completeness or replace the Core's DOI, preservation
and Vault checks. Existing Add to Obsidian and plain Markdown downloads are
unchanged and still retain remote images.

## Limits

- PNG, JPEG, GIF, WebP and AVIF with matching response type and file signature.
- Maximum 200 distinct images, 20 MiB per image, 100 MiB total image data,
  5 MiB Markdown characters, and 15 seconds per image request.
- HTTP(S) public hostname URLs only. No embedded URL credentials, literal IP
  addresses, local hostnames, data/blob/file URLs, SVG, HTML media or Obsidian
  wiki embeds. Such media produces an explicit error instead of a partial ZIP.
- Downloads omit cookies and referrer, and reject redirects. Signed URLs are
  used intact. Authentication-dependent, expired, redirecting or blocked image
  requests may fail even when the webpage can display the image. Browser
  network protections apply; this route does not perform Core's DNS pinning.
- Any detected image failure aborts the ZIP. The editor and existing Vault
  remain unchanged; the error does not print signed URLs or credentials.
- No private publisher captures are included in tests. Synthetic Chromium
  coverage does not establish compatibility with every publisher or browser.
