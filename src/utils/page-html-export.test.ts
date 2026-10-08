// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from './browser-polyfill';
import { saveFile } from './file-utils';
import { capturePageHtml, exportPageHtml, PageHtmlSnapshot } from './page-html-export';

vi.mock('./browser-polyfill', () => ({ default: {
	scripting: { executeScript: vi.fn() },
	runtime: { getManifest: () => ({ version: '1.7.1' }) },
} }));
vi.mock('./file-utils', () => ({ saveFile: vi.fn() }));

const url = window.location.href;

beforeEach(() => {
	vi.resetAllMocks();
	document.documentElement.innerHTML = `<head><meta charset="gbk"><title>Paper: sample</title>
		<script type="application/ld+json">{"@type":"ScholarlyArticle","name":"Paper"}</script>
		<script>window.secret = 'session-script';</script><meta http-equiv="refresh" content="1;url=/login">
		<style>article { color: black; }</style></head><body>
		<article><h1>Paper</h1><h2>Results</h2><p>Rendered full text.</p>
		<figure><img src="figure.png"><figcaption>Figure 1 caption</figcaption></figure>
		<table><tr><th>Group</th><th>Score</th></tr><tr><td>A</td><td>42</td></tr></table>
		<script type="math/tex">E=mc^2</script></article>
		<input type="password" value="password-secret"><input type="hidden" value="csrf-secret">
		<textarea>private draft</textarea><button onclick="alert(1)">Button</button>
		<iframe srcdoc="private frame"></iframe><div id="obsidian-clipper-container">Extension UI</div>
		</body>`;
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.documentElement.className = '';
	document.head.replaceChildren();
	document.body.replaceChildren();
});

function snapshot(): PageHtmlSnapshot {
	const result = capturePageHtml();
	if ('error' in result) throw new Error(result.error);
	return result.snapshot;
}

describe('current-page HTML snapshot', () => {
	it('preserves the rendered article, metadata, figures and tables without mutating the page', () => {
		const before = document.documentElement.outerHTML;
		const dynamic = document.createElement('p');
		dynamic.textContent = 'Loaded after login';
		document.querySelector('article')!.append(dynamic);
		const result = snapshot();
		expect(result.html).toContain('Loaded after login');
		expect(result.html).toContain('application/ld+json');
		expect(result.html).toContain('Figure 1 caption');
		expect(result.html).toContain('<td>42</td>');
		expect(result.html).toContain('math/tex');
		expect(result.html).toContain('<meta charset="utf-8">');
		expect(result.url).toBe(url);
		expect(result.baseURI).toBe(url);
		expect(result.htmlBytes).toBe(new Blob([result.html]).size);
		dynamic.remove();
		expect(document.documentElement.outerHTML).toBe(before);
	});

	it('excludes form values, executable code, nested frames and extension controls', () => {
		const { html } = snapshot();
		for (const secret of ['password-secret', 'csrf-secret', 'private draft', 'session-script', 'private frame', 'Extension UI']) {
			expect(html).not.toContain(secret);
		}
		expect(html).not.toContain('onclick');
		expect(html).not.toContain('http-equiv="refresh"');
		expect(html).toContain("default-src 'none'");
	});

	it('is serializable for isolated-world injection without module dependencies', () => {
		const injected = new Function(`return (${capturePageHtml.toString()})();`);
		expect(injected().snapshot.html).toContain('Rendered full text.');
	});

	it('rejects reader mode, non-web documents and oversized snapshots', () => {
		document.documentElement.classList.add('obsidian-reader-active');
		expect(capturePageHtml()).toEqual({ error: 'htmlExportExitReader' });
		document.documentElement.classList.remove('obsidian-reader-active');
		vi.stubGlobal('location', new URL('file:///private.html'));
		expect(capturePageHtml()).toEqual({ error: 'htmlExportUnsupportedPage' });
		vi.stubGlobal('location', new URL(url));
		vi.stubGlobal('Blob', class { size = 31 * 1024 * 1024; });
		expect(capturePageHtml()).toEqual({ error: 'htmlExportTooLarge' });
	});
});

describe('HTML export downloads', () => {
	it('captures only the selected top frame and downloads a matching UTF-8 HTML/JSON pair', async () => {
		const captured = snapshot();
		vi.mocked(browser.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { snapshot: captured } }]);
		await exportPageHtml(42, url);
		expect(browser.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 42, frameIds: [0] }, func: capturePageHtml });
		const [html, json] = vi.mocked(saveFile).mock.calls.map(call => call[0]);
		expect(html.content).toBe(captured.html);
		expect(html.mimeType).toBe('text/html');
		expect(html.fileName).not.toMatch(/[<>:"/\\|?*]/);
		expect(json.fileName).toBe(`${html.fileName}.json`);
		expect(JSON.parse(json.content)).toMatchObject({
			schemaVersion: 1, captureMethod: 'clipper-dom', sourceUrl: url, url,
			charset: 'UTF-8', htmlFile: html.fileName, status: 'unchecked', htmlBytes: captured.htmlBytes,
		});
		expect(json.content).not.toContain(captured.html);
	});

	it('refuses a navigation race instead of pairing one page with another URL', async () => {
		vi.mocked(browser.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { snapshot: { ...snapshot(), url: url + '/different' } } }]);
		await expect(exportPageHtml(42, url)).rejects.toThrow('htmlExportPageChanged');
		expect(saveFile).not.toHaveBeenCalled();
	});

	it('allows an in-page anchor change', async () => {
		vi.mocked(browser.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { snapshot: { ...snapshot(), url: url + '#Methods' } } }]);
		await exportPageHtml(42, url);
		expect(saveFile).toHaveBeenCalledTimes(2);
	});

	it('reports missing results, script errors and unsupported URLs without downloads', async () => {
		await expect(exportPageHtml(42, 'chrome://extensions')).rejects.toThrow('htmlExportUnsupportedPage');
		expect(browser.scripting.executeScript).not.toHaveBeenCalled();
		vi.mocked(browser.scripting.executeScript).mockResolvedValue([]);
		await expect(exportPageHtml(42, url)).rejects.toThrow('htmlExportFailed');
		vi.mocked(browser.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { error: 'htmlExportExitReader' } }]);
		await expect(exportPageHtml(42, url)).rejects.toThrow('htmlExportExitReader');
		vi.mocked(browser.scripting.executeScript).mockRejectedValue(new Error('Tab closed'));
		await expect(exportPageHtml(42, url)).rejects.toThrow('Tab closed');
		expect(saveFile).not.toHaveBeenCalled();
	});

	it('propagates saveFile errors instead of reporting success or requesting another download', async () => {
		vi.mocked(browser.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { snapshot: snapshot() } }]);
		vi.mocked(saveFile).mockImplementation(async options => { options.onError!(new Error('Download failed')); });
		await expect(exportPageHtml(42, url)).rejects.toThrow('Download failed');
		expect(saveFile).toHaveBeenCalledTimes(1);
	});
});
