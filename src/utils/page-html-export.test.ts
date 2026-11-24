// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from './browser-polyfill';
import { saveFile } from './file-utils';
import { capturePageHtml, exportPageHtml, captureDocumentWithMath, PageHtmlSnapshot } from './page-html-export';
import { runtimeMathHtml, installSyntheticMathJax } from '../../scripts/fixtures/mathjax-runtime.mjs';
import { checkMathPreservation, mathInventory } from './paper-math.mjs';
import { parseForClip } from './clip-utils';
import { createMarkdownContent } from 'defuddle/full';

vi.mock('./browser-polyfill', () => ({ default: {
	scripting: { executeScript: vi.fn() },
	runtime: { getManifest: () => ({ version: '1.7.1' }), sendMessage: vi.fn() },
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
	delete (window as any).MathJax;
	document.documentElement.className = '';
	document.head.replaceChildren();
	document.body.replaceChildren();
});

async function snapshot(): Promise<PageHtmlSnapshot> {
	const result = await capturePageHtml();
	if ('error' in result) throw new Error(result.error);
	return result.snapshot;
}

describe('current-page HTML snapshot', () => {
	it('preserves the rendered article, metadata, figures and tables without mutating the page', async () => {
		const before = document.documentElement.outerHTML;
		const dynamic = document.createElement('p');
		dynamic.textContent = 'Loaded after login';
		document.querySelector('article')!.append(dynamic);
		const result = await snapshot();
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

	it('excludes form values, executable code, nested frames and extension controls', async () => {
		const { html } = await snapshot();
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
		const captured = await snapshot();
		vi.mocked(browser.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { snapshot: captured } }]);
		await exportPageHtml(42, url);
		expect(browser.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 42, frameIds: [0] }, world: 'MAIN', func: capturePageHtml });
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
		vi.mocked(browser.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { snapshot: { ...await snapshot(), url: url + '/different' } } }]);
		await expect(exportPageHtml(42, url)).rejects.toThrow('htmlExportPageChanged');
		expect(saveFile).not.toHaveBeenCalled();
	});

	it('allows an in-page anchor change', async () => {
		vi.mocked(browser.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { snapshot: { ...await snapshot(), url: url + '#Methods' } } }]);
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
		vi.mocked(browser.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { snapshot: await snapshot() } }]);
		vi.mocked(saveFile).mockRejectedValueOnce(new Error('Download failed'));
		await expect(exportPageHtml(42, url)).rejects.toThrow('Download failed');
		expect(saveFile).toHaveBeenCalledTimes(1);
	});
});

describe('retained MathJax input capture', () => {
	it('captures lazy MathML and TeX by DOM identity without scrolling or changing the live page', async () => {
		document.documentElement.innerHTML = runtimeMathHtml;
		installSyntheticMathJax();
		const before = document.documentElement.outerHTML;
		const injected = new Function(`return (${capturePageHtml.toString()})();`);
		const captured = new DOMParser().parseFromString(injected().snapshot.html, 'text/html');
		expect(mathInventory(captured)).toHaveLength(5);
		const markdown = createMarkdownContent(parseForClip(captured).content, url);
		expect(checkMathPreservation(captured, markdown)).toMatchObject({ status: 'passed', expected: 5, matched: 5 });
		expect(markdown).toContain('bold caption text');
		expect(markdown).toContain('\\left\\|x\\right\\|');
		expect(markdown).toContain('\\begin{aligned}');
		expect(markdown).toContain('(2)');
		expect(document.documentElement.outerHTML).toBe(before);
	});

	it.each(['&nbsp;', '&#160;', '&#xA0;', '\u00a0'])('captures nonbreaking spaces (%s) without relaxing XML validation', space => {
		document.body.innerHTML = '<mjx-container><mjx-lazy></mjx-lazy></mjx-container>';
		const target = document.querySelector('mjx-container')!;
		(window as any).MathJax = { startup: { document: { math: [{ typesetRoot: target,
			math: `<math><mi>x</mi><mo>;</mo><mtext>${space}where</mtext></math>`,
			display: false, inputJax: { name: 'MathML' } }] } } };
		const injected = new Function(`return (${capturePageHtml.toString()})();`);
		const captured = new DOMParser().parseFromString(injected().snapshot.html, 'text/html');
		const retained = captured.querySelector('mjx-container')!.getAttribute('data-paper-mathml')!;
		expect(new DOMParser().parseFromString(retained, 'application/xml').querySelector('mtext')?.textContent).toBe('\u00a0where');
		expect(mathInventory(captured)[0]).toMatchObject({ latex: 'x ; \\textrm{ }\\text{where}' });
		expect(target.hasAttribute('data-paper-mathml')).toBe(false);
	});

	it('does not recursively decode escaped entity text', async () => {
		document.body.innerHTML = '<mjx-container><mjx-lazy></mjx-lazy></mjx-container>';
		(window as any).MathJax = { startup: { document: { math: [{ typesetRoot: document.querySelector('mjx-container'),
			math: '<math><mtext>&amp;nbsp;</mtext></math>', display: false, inputJax: { name: 'MathML' } }] } } };
		const captured = new DOMParser().parseFromString((await snapshot()).html, 'text/html');
		const retained = captured.querySelector('mjx-container')!.getAttribute('data-paper-mathml')!;
		expect(new DOMParser().parseFromString(retained, 'application/xml').querySelector('mtext')?.textContent).toBe('&nbsp;');
	});

	it('ignores detached, mismatched, oversized and unsafe runtime inputs', async () => {
		document.body.innerHTML = '<mjx-container><mjx-lazy></mjx-lazy></mjx-container>';
		const target = document.querySelector('mjx-container')!;
		const bad = [
			{ typesetRoot: target.cloneNode(true), math: '<math><mi>x</mi></math>' },
			{ typesetRoot: target, math: '<math><script>unsafe()</script></math>' },
			{ typesetRoot: target, math: '<math><annotation-xml><html>bad</html></annotation-xml></math>' },
			{ typesetRoot: target, math: '<math><mtext>&nbsp;&unknown;</mtext></math>' },
			{ typesetRoot: target, math: '<math><mtext>&nbsp;where</mi></math>' },
			{ typesetRoot: target, math: '<math><mtext>&nbsp;where</mtext><script>unsafe()</script></math>' },
			{ typesetRoot: target, math: '<math><mtext xmlns="https://example.org/foreign">&nbsp;where</mtext></math>' },
			{ typesetRoot: target, math: '<math><mi>' + 'x'.repeat(200001) + '</mi></math>' },
			{ typesetRoot: target, math: '<math><mi>x</mi></math>', inputJax: { name: 'Unknown' } },
		];
		for (const item of bad) {
			(window as any).MathJax = { startup: { document: { math: [{ display: false, inputJax: { name: 'MathML' }, ...item }] } } };
			const captured = new DOMParser().parseFromString((await snapshot()).html, 'text/html');
			expect(captured.querySelector('[data-paper-mathml], [data-latex]')).toBeNull();
			expect(checkMathPreservation(captured, '').status).toBe('failed');
		}
	});

	it.each(['available', 'delayed', 'missing'] as const)('extracts against actual retained inputs when the second formula is %s', async mode => {
		document.querySelector('article')!.insertAdjacentHTML('beforeend',
			'<mjx-container data-latex="a"></mjx-container><span class="display-formula" id="eq-B"><mjx-container><mjx-lazy></mjx-lazy></mjx-container></span>');
		const root = document.querySelector('#eq-B mjx-container')!;
		const input = { typesetRoot: root, math: 'b^2', display: false, inputJax: { name: 'TeX' } };
		const inputs = mode === 'available' ? [input] : [];
		let ready!: () => void;
		const reads = vi.fn(() => inputs);
		const startup = { promise: new Promise<void>(resolve => { ready = resolve; }), document: { get math() { return reads(); } } };
		(window as any).MathJax = { startup };
		// executeScript ships this function alone to the page's MAIN world.
		const inject = new Function('return (' + capturePageHtml.toString() + ')()');
		const pending = inject();
		expect(reads).toHaveBeenCalledTimes(1);
		if (mode === 'available') expect(pending.snapshot).toBeDefined(); // no wait even if startup never settles
		else {
			if (mode === 'delayed') inputs.push(input);
			ready();
		}
		const captured = new DOMParser().parseFromString((await pending).snapshot.html, 'text/html');
		expect(reads).toHaveBeenCalledTimes(mode === 'available' ? 1 : 2);
		if (mode === 'missing') {
			expect(() => parseForClip(captured)).toThrow(/#2 \(eq-B\): Lazy placeholder has no MathML or TeX source/);
		} else {
			const markdown = createMarkdownContent(parseForClip(captured).content, url);
			expect(checkMathPreservation(captured, markdown)).toMatchObject({ status: 'passed', expected: 2, matched: 2 });
		}
		expect(root.hasAttribute('data-latex')).toBe(false);
	});

	it('reports malformed retained MathML immediately even if startup is pending', () => {
		document.body.innerHTML = '<mjx-container><mjx-lazy></mjx-lazy></mjx-container>';
		(window as any).MathJax = { startup: { promise: new Promise(() => {}), document: { math: [{
			typesetRoot: document.querySelector('mjx-container'), inputJax: { name: 'MathML' }, display: false,
			math: '<math><mi>x</math>',
		}] } } };
		const result = capturePageHtml();
		expect(result).not.toBeInstanceOf(Promise);
		if (!('snapshot' in result)) throw new Error('Expected immediate diagnostic snapshot');
		const captured = new DOMParser().parseFromString(result.snapshot.html, 'text/html');
		expect(() => parseForClip(captured)).toThrow(/#1 \(mathjax-1\): Invalid MathML XML/);
	});

	it('bounds startup waits and never recaptures on late settlement or navigation', async () => {
		vi.useFakeTimers();
		try {
			document.body.innerHTML = '<mjx-container><mjx-lazy></mjx-lazy></mjx-container>';
			let ready!: () => void;
			const reads = vi.fn(() => []);
			const startup = { promise: new Promise<void>(r => { ready = r; }), document: { get math() { return reads(); } } };
			(window as any).MathJax = { startup };
			const first = snapshot();
			await vi.advanceTimersByTimeAsync(5000);
			expect((await first).html).toContain('mjx-lazy');
			ready();
			await Promise.resolve();
			expect(reads).toHaveBeenCalledTimes(1);
			const second = capturePageHtml();
			history.replaceState(null, '', '/different-article');
			await expect(second).resolves.toEqual({ error: 'htmlExportPageChanged' });
			expect(reads).toHaveBeenCalledTimes(2);
		} finally { history.replaceState(null, '', url); vi.useRealTimers(); }
	});

	it('uses a same-page captured document and fails closed on snapshot errors or navigation', async () => {
		document.documentElement.innerHTML = runtimeMathHtml;
		installSyntheticMathJax();
		const captured = await snapshot();
		vi.mocked(browser.runtime.sendMessage).mockResolvedValue({ snapshot: captured });
		const copy = await captureDocumentWithMath(document);
		expect(copy).not.toBe(document);
		expect(copy.URL).toBe(document.URL);
		expect(mathInventory(copy).every(item => !item.error)).toBe(true);
		vi.mocked(browser.runtime.sendMessage).mockResolvedValue({ snapshot: { ...captured, url: url + 'different' } });
		expect(await captureDocumentWithMath(document)).toBe(document);
		vi.mocked(browser.runtime.sendMessage).mockResolvedValue({ error: 'htmlExportPageChanged' });
		await expect(captureDocumentWithMath(document)).rejects.toMatchObject({ code: 'paper-page-changed' });
		vi.mocked(browser.runtime.sendMessage).mockRejectedValue(new Error('Unsupported browser'));
		expect(await captureDocumentWithMath(document)).toBe(document);
		expect(checkMathPreservation(document, '').status).toBe('failed');
	});
});
