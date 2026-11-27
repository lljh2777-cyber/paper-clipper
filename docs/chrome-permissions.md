# Paper Clipper Chrome permissions

**Single purpose for the Chrome Web Store.** Paper Clipper captures web articles
as Markdown for a personal paper collection. Users can inspect and highlight
the source, preserve formulas and selected assets, and save the result to
a local folder, including an Obsidian vault.

The explanations below describe the [Chrome manifest](../src/manifest.chrome.json).
For data destinations and retention, see the [privacy policy](../PRIVACY.md).

| Manifest entry | What Paper Clipper uses it for |
| --- | --- |
| `activeTab` | Access the current tab when the user invokes the extension to preview, highlight or clip that page. |
| `scripting` | Inject the clipping, reading and highlighting code into a permitted tab. HTML capture also reads the page's rendered math so a saved paper can retain its formulas. The paired queue runs capture in the tab it opens for a job. |
| `contextMenus` | Offer commands on the page or selection to save, copy Markdown, open the reader or highlight the selected content. |
| `sidePanel` | Show the clip preview and save controls alongside the article in Chrome's side panel. |
| `clipboardWrite` | Write Markdown or highlights to the system clipboard when the user chooses Copy. |
| `storage` | Keep highlights and recent actions locally, store preferences and templates in Chrome sync storage, remember local queue pairing, and pass a pending save between extension pages in session storage. |
| `alarms` | Wake the background worker to poll the user's enabled, paired local paper queue once per minute, including after the queue page is closed. |
| Host access (`http://*/*`, `https://*/*`) | Restore highlights on revisited sites, capture papers from publishers chosen by the user or their queue, and fetch figures and selected supplements from the hosts linked by a paper. Paired jobs also contact the local service at 127.0.0.1. Publishers and asset hosts vary by paper. |
| Keyboard shortcuts (top-level `commands`) | Open the clipper, quick-clip, or toggle the reader or highlighter via Chrome's top-level `commands` manifest key. |

Paper folders, ZIP archives and Markdown files use the browser directory picker and its file access grant.

## Notes for the store submission

- Publish the [privacy policy](../PRIVACY.md) at a publicly accessible URL
  and enter that direct URL in the store dashboard. Its disclosures must match
  the submitted build, including website content, page URLs, local queue
  transfer, Chrome sync and site-specific third-party requests.
  [Chrome Web Store privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
