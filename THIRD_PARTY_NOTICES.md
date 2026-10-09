# Third-Party Notices

## Upstream Source And History

Paper Clipper is an independent, unofficial project based on
[Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper).
It is not an official Obsidian release and does not claim upstream endorsement.
The full development repository preserves upstream commits and authorship.
GitHub contributor counts reflect retained history, not membership in the
current Paper Clipper maintenance team or participation in its new features.

Copyright (c) 2024 Obsidian. The complete upstream MIT copyright and permission
notice is retained without modification in [LICENSE](LICENSE). Original notices
must accompany copies or substantial portions of the upstream software.

## Branding And Distribution Boundaries

The upstream [license section](https://github.com/obsidianmd/obsidian-clipper#license)
excludes trademarks, icons, marketing copy and other marketing assets from its
MIT grant. The browser extension UI now uses Paper Clipper names and document
icons instead of upstream logos and official-product descriptions. Its project,
help and feedback links identify this repository; upstream attribution remains.
The document icon is rendered from Lucide FileText (see below), not Obsidian art.

Historical marketing files under `assets/` and the native `xcode/` wrapper are
retained for provenance and are not part of the Chromium webpack package. Their
presence does not grant permission to redistribute them. The native Safari app
has not been rebranded or validated. This change is not a complete distribution,
dependency-license or extension-store compliance audit.

## Lucide Icons

The application mark and toolbar icons use Lucide. `npm run build:icons`
regenerates the checked-in SVG and PNG application icons from the installed
Lucide FileText icon. Chromium builds include Lucide's complete ISC notice as
`LICENSE-lucide.txt`, alongside the upstream MIT `LICENSE.txt` and this document.

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part
of Feather (MIT). All other copyright (c) for Lucide are held by Lucide
Contributors 2022.

The standalone Core export omits the extension UI, brand assets and browser
packaging, while retaining LICENSE and its own
[Third-Party Notices](docs/core/THIRD_PARTY_NOTICES.md). A new repository or new
Git history would not remove the requirement to retain applicable notices.

## Dependencies And Paper Content

Manual image ZIP export uses fflate (MIT), copyright (c) 2026 Arjun Barrett.
Extension builds include its full notice in `LICENSE-fflate.txt`.

Third-party dependencies retain their respective licenses and notices. Consult
their installed license files before distributing bundled dependencies or
binaries. This document is attribution and scope guidance, not an exhaustive
dependency or asset license audit.

Publisher articles, figures and authorized HTML captures are separate content.
They are not distributed by this repository and do not acquire the software's
MIT license. Local browser profiles, personal Vaults and private captures must
not be committed or included in release archives.
