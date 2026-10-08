# Local image attachments

Add `--download-assets` to the unified command to save paper images beside the
Markdown and replace their embedded URLs with portable relative paths. Without
this flag, existing behavior is unchanged: HTML imports make no network requests
and image URLs remain remote.

Run from `E:\Paper_Clipper\obsidian-clipper`:

```powershell
npm run clip -- "https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1012386" --download-assets
npm run clip -- "E:\Paper_Clipper\exported-paper.html" --download-assets
npm run clip -- "E:\Paper_Clipper" --download-assets -o "E:\Paper_Clipper\converted"
```

Both lower-level commands, `clip:paper` and `clip:import`, accept the same flag.
With local HTML the page is still never fetched again and no browser is opened,
but **image downloads do use the network**. No browser cookies, authorization
headers or login profiles are read or transferred. Images requiring authentication
may therefore fail even when the captured article contains full text.

## Output and preservation

For `paper.md`, attachments go into a new sibling directory such as
`paper.assets-Ab12Cd/image-001.png`. Long paper basenames are shortened for the
directory prefix. Keep the Markdown and its attachment directory together when
moving them, including when copying into an Obsidian Vault.

The downloader runs only after the paper body passes existing content checks.
Within a paper, repeated image URLs share one attachment; ordinary links to the
same URL remain unchanged. It downloads the image already selected by the
converter, not a guessed higher-resolution version. Image formulas remain images,
not newly inferred TeX. A Markdown parser with source positions confines edits to
image nodes; prose, code, dollar-delimited formulas, citations and frontmatter are
not rewritten. Reference-style image uses are made inline while shared link
definitions are retained. HTML `img src` is supported; a localized `img` loses its
own `srcset` so the reader uses the saved source.

Supported downloadable types are PNG, JPEG, GIF, WebP and AVIF, with both MIME
and file-signature checks. SVG, data/blob URLs, local-file URLs and other formats
are retained with an unresolved-image report. This is not an HTML page archiver:
CSS backgrounds, `picture/source` alternatives, video, PDFs, supplementary files
and external links are not downloaded. `assets.status: complete` refers to the
detected Markdown images and HTML `img src` values, not every possible page resource.

Existing Markdown is still skipped by default, including when adding the flag.
To intentionally regenerate a previously saved paper with local images:

```powershell
npm run clip -- "E:\Paper_Clipper\exported-paper.html" --download-assets --overwrite
```

Every conversion uses a fresh attachment directory, including overwrites. Old
attachments, original exports and earlier reports are never deleted or overwritten.
If publishing Markdown fails, downloaded files remain as diagnostic artifacts.
No cross-run cache, automatic retry or cleanup is performed. Users must clean up
unneeded run/attachment directories manually.

## Failure reporting

An image failure does **not** discard otherwise accepted Markdown. Its original
image syntax/URL stays intact; successful images use local relative paths.
The terminal prints downloaded/unresolved totals. Each paper, batch and unified
item includes `assets` when the flag was used:

- `status`: `complete` or `partial`.
- `occurrences`: embedded image uses, including repeats.
- `downloaded` / `failed`: unique source totals; `bytes`: saved image bytes.
- `directory`: attachment directory, absent if nothing was saved.
- `items`: original source, occurrences and status; saved path/type/size/final URL
  for successes, or error text for failures.

The unified next step is `review-assets` when an accepted paper has unresolved
images when `--vault` is absent. Without `--vault`, exit codes describe **paper
conversion**: a saved paper with partial images exits `0`. With `--vault`, those
images block archiving, produce `repair-assets-before-archive`, and exit `1`.
Automation using conversion alone must also require
`assets.status === "complete"`, then validate rendering for its target reader.
The stricter `accept:assets` command below exits nonzero for any unresolved image
or failed decode. Source/final URLs in reports may include transient signed query
parameters; keep the reports private along with other captures.

Limits per paper: 200 unique URLs, 20 MiB per image, 100 MiB saved image bytes,
five redirects per request, and 15 seconds per image (lowered by a smaller
`--timeout`). Downloads are sequential. Only public HTTP(S) destinations without
embedded credentials are allowed. Private/reserved IP literals, DNS results and
redirect destinations are rejected; validated DNS results are supplied directly
to the connection. Publisher-provided filenames are never used for local paths.
These checks do not authenticate a publisher or prove that a decoded image is
scientifically correct.

## Verification

```powershell
npm run test:assets
npm run test:clip
npm run accept:papers
npm run accept:assets
```

`test:assets` uses authored/local fixtures. The unified tests cover flag forwarding,
partial-image advice, imports with and without network opt-in, skip behavior and
the rule that rejected content never reaches image downloading.

`accept:papers` remains an offline conversion replay. The separate `accept:assets`
uses the same five retained full-content samples, explicitly downloads live image
URLs, checks text/reference preservation, and loads a local image gallery in
Chromium **with networking disabled**. It checks every image's decode and natural
dimensions, records screenshots, closes the browser, and creates a fresh run in
`output/browser-fetch/asset-acceptance/`. Local captures and Chromium are required;
missing inputs fail instead of being silently skipped. It is not an Obsidian UI
test or a validation of scientific notation/whole-page layout.

Verified on 2026-10-08:

| Sample | Unique saved images | Offline decoded uses | Notes |
| --- | ---: | ---: | --- |
| Hi-C | 7 | 7/7 | Existing reference comparison retained. |
| DeepMet | 5 | 5/5 | Existing reviewed math corrections retained. |
| Novae extension export | 6 | 6/6 | Original legacy body reference matched before image localization; subsequent full-legend verification is documented below. |
| PLOS binomial model | 18 | 24/24 | Includes all 11 equation images; repeated figures share files. |
| Frontiers LFSC | 9 | 9/9 | Includes the source's extra Crossmark graphic. |

All five passed: **45 attachments, 51 decoded image uses, zero unresolved images**.
The PLOS gallery screenshot was also visually checked. Original image resolution
is preserved, so small publisher equation bitmaps can look blurred when enlarged.
These results validate the retained samples and this download run, not universal
publisher support or future remote availability.

The earlier Nature manual references also omitted long figure legends. The
subsequent [source-backed caption checks](paper-acceptance.md#nature-full-figure-legends)
verify six restored Novae legends and five DeepMet legends independently of those
legacy references. Image localization continues to compare all non-image content
exactly; it does not remove or relax caption checks.
