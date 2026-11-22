# Paper Clipper privacy policy

This policy covers the Paper Clipper Chrome extension maintained by the
[Paper Clipper project](https://github.com/lljh2777-cyber/paper-clipper).
You can clip a paper without creating a Paper Clipper account. The project
does not operate a server that receives your clips or collect usage analytics.

## What the extension reads

On HTTP and HTTPS pages where Chrome allows site access, a small content script
sends the current URL to the extension's own background process. It checks for
saved highlights so they can reappear when you revisit the page. This check
takes place in the browser, including on pages you never clip.

When you open the clipper, use the reader, highlight content or run a paired
queue job, the extension can read the page URL, title, selected text, article
HTML, metadata, formulas and links to images and attachments. A capture can
include material visible because you are signed in, private page text and query
parameters in URLs. HTML export and queue capture remove ordinary scripts and
clear input values and textarea text. Other personal information present in
the document can remain in the snapshot.

## What is saved

| Location | Contents and retention |
| --- | --- |
| Chrome extension storage on this device | Saved highlights and their page URLs, page and site metadata, and up to 1,000 recent clipper actions. An action record can include its time, URL, title, vault and note path. Queue pairing credentials are stored locally. |
| Chrome sync storage | Preferences, templates, vault names, property definitions and action counts. Chrome can sync these through your browser account if extension sync is enabled. Text and paths you enter in templates can be part of this data. |
| Temporary extension session storage | The extension can hold the edited paper and save details while it hands a save to a background tab. Queue task state can also be held during a browser session. |
| Your files | A save can create Markdown, HTML, images, selected supplements, ZIP files and reports. The extension remembers the default paper folder through a local browser directory handle. A folder chosen for one paper is held only in its save tab. The Archives view reads archive metadata from the folder you authorize. |

## When data goes to another destination

- **Paper sites and media hosts.** Reader navigation and refreshing highlighted
  pages can request the source page again. Displaying images, site icons or
  embedded media can contact their hosts. Saving images or selected supplements
  requests the linked file URL, which may include a signed query string.
  The archive downloader omits browser credentials and the referring page URL.
  Servers receiving a request can see your IP address and the requested resource.
- **Site-specific extraction.** On supported sites the clipper or reader may
  request content from an external service during extraction. For example,
  extracting an X post can send its URL to X's embed service or its account
  name and post ID to FxTwitter. YouTube and Bilibili can receive video IDs
  and requests for playback information or captions. These requests can occur
  when previewing a clip, before you save it.
- **Clipboard.** Copy writes the selected text or note to the system clipboard.
  Other apps with clipboard access and any sync service you enable for your
  vault or output folder are subject to their own settings and policies.
- **Optional local queue.** Pairing connects the extension to the Paper Clipper
  service you run at `http://127.0.0.1:PORT` on the same computer. Once paired
  and enabled, it can open job tabs and send their HTML snapshots, URLs, base
  URLs, titles and capture times to that service in the background. The local
  service uses its own output directory. Manual clipping does not require pairing.

Paper Clipper uses this information to provide its clipping, reading,
highlighting and saving features. It does not sell user data, use it for
advertising or credit decisions, or send paper content to an AI service.
Paper Clipper uses and transfers information received from Chrome APIs in
accordance with the Chrome Web Store User Data Policy, including its
[Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

## Your controls and contact

You can restrict site access in Chrome's extension settings and clear a page's
highlights with the highlighter. **Forget pairing** removes the extension's
local key. **Reset pairing** also invalidates the old key at the running
service. Forgetting the default directory releases the saved folder reference.
Removing the extension clears its local extension storage. Files already saved
in Downloads, a vault, a backup or the queue output directory remain under
your control and can be deleted there.

For privacy questions, contact the maintainer through the
[Paper Clipper issue tracker](https://github.com/lljh2777-cyber/paper-clipper/issues).
Issues are public. Please omit paper contents, private URLs and pairing keys.
