import browser from './browser-polyfill';
import { saveFile } from './file-utils';
import { sanitizeFileName } from './string-utils';

export interface PageHtmlSnapshot {
	html: string;
	url: string;
	baseURI: string;
	title: string;
	capturedAt: string;
	htmlBytes: number;
}

type SnapshotResult = { snapshot: PageHtmlSnapshot } | { error: string };

// executeScript serializes this function: keep it independent of module scope.
export function capturePageHtml(): SnapshotResult {
	if (window !== window.top || !/^https?:$/.test(location.protocol)) {
		return { error: 'htmlExportUnsupportedPage' };
	}
	if (document.documentElement.classList.contains('obsidian-reader-active')) {
		return { error: 'htmlExportExitReader' };
	}
	const capturedAt = new Date().toISOString();
	const clone = document.documentElement.cloneNode(true) as HTMLElement;
	// MathJax 3/4 can replace original MathML with a lazy placeholder or a
	// font-only render tree. Read its existing input, matched by DOM identity,
	// onto this snapshot only. Do not typeset, scroll, fetch, or change the page.
	const liveMath = Array.from(document.querySelectorAll('mjx-container'));
	const copiedMath = Array.from(clone.querySelectorAll('mjx-container'));
	try {
		const items = (window as any).MathJax?.startup?.document?.math;
		if (items && typeof items[Symbol.iterator] === 'function') {
			const used = new Set<Element>();
			for (const item of items) {
				const index = liveMath.indexOf(item.typesetRoot);
				const target = copiedMath[index];
				if (!target || used.has(target) || typeof item.math !== 'string' ||
					!item.math.trim() || item.math.length > 200000 || typeof item.display !== 'boolean') continue;
				const kind = item.inputJax?.name;
				if (kind === 'MathML') {
					const parsed = new DOMParser().parseFromString(item.math, 'application/xml');
					const math = parsed.documentElement;
					if (math.localName !== 'math' || parsed.querySelector('parsererror') ||
						Array.from(math.querySelectorAll('*')).some(el =>
							!['', null, 'http://www.w3.org/1998/Math/MathML'].includes(el.namespaceURI) ||
							['script', 'style', 'annotation-xml'].includes(el.localName))) continue;
					// Keep source data inert until the existing math converter parses it.
					target.setAttribute('data-paper-mathml', math.outerHTML);
					target.removeAttribute('data-latex');
					target.removeAttribute('data-tex');
				} else if (kind === 'TeX') {
					target.setAttribute('data-latex', item.math);
					target.removeAttribute('data-paper-mathml');
				}
				else continue;
				target.setAttribute('display', String(item.display));
				used.add(target);
			}
		}
	} catch { /* Unsupported runtimes remain subject to the normal math gate. */ }
	// Preserve article metadata and math, but do not export executable page code.
	clone.querySelectorAll('script').forEach(script => {
		const type = (script.getAttribute('type') || '').trim().toLowerCase();
		if (type !== 'application/ld+json' && !/^math\/tex(?:;|$)/.test(type)) script.remove();
	});
	clone.querySelectorAll('iframe, object, embed, #obsidian-clipper-container, .obsidian-highlighter-menu, .obsidian-highlight-overlay, .obsidian-highlight-delete').forEach(element => element.remove());
	clone.querySelectorAll('input').forEach(input => {
		input.removeAttribute('value');
		input.removeAttribute('checked');
	});
	clone.querySelectorAll('textarea').forEach(textarea => { textarea.textContent = ''; });
	clone.querySelectorAll('option[selected]').forEach(option => option.removeAttribute('selected'));
	clone.querySelectorAll('*').forEach(element => {
		for (const attribute of Array.from(element.attributes)) {
			if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
		}
	});
	clone.querySelectorAll('meta[charset], meta[http-equiv]').forEach(meta => meta.remove());
	const head = clone.querySelector('head') || clone.insertBefore(document.createElement('head'), clone.firstChild);
	const charset = document.createElement('meta');
	charset.setAttribute('charset', 'utf-8');
	const policy = document.createElement('meta');
	policy.setAttribute('http-equiv', 'Content-Security-Policy');
	policy.setAttribute('content', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri http: https:; form-action 'none'");
	head.prepend(charset, policy);
	const html = '<!DOCTYPE html>\n' + clone.outerHTML;
	const htmlBytes = new Blob([html]).size;
	if (htmlBytes > 30 * 1024 * 1024) return { error: 'htmlExportTooLarge' };
	return { snapshot: { html, url: location.href, baseURI: document.baseURI, title: document.title, capturedAt, htmlBytes } };
}

export async function exportPageHtml(tabId: number, sourceUrl: string): Promise<void> {
	if (!/^https?:\/\//i.test(sourceUrl)) throw new Error('htmlExportUnsupportedPage');
	const results = await browser.scripting.executeScript({
		target: { tabId, frameIds: [0] },
		world: 'MAIN',
		func: capturePageHtml,
	});
	const result = results[0]?.result as SnapshotResult | undefined;
	if (!result) throw new Error('htmlExportFailed');
	if ('error' in result) throw new Error(result.error);
	const snapshot = result.snapshot;
	const requested = new URL(sourceUrl);
	const captured = new URL(snapshot.url);
	requested.hash = captured.hash = '';
	if (requested.href !== captured.href) throw new Error('htmlExportPageChanged');

	const stem = sanitizeFileName(snapshot.title).slice(0, 100);
	const timestamp = snapshot.capturedAt.replace(/[^0-9]/g, '');
	const fileName = `${stem}-${timestamp}.html`;
	const metadata = {
		schemaVersion: 1,
		captureMethod: 'clipper-dom',
		extensionVersion: browser.runtime.getManifest().version,
		sourceUrl,
		url: snapshot.url,
		baseURI: snapshot.baseURI,
		title: snapshot.title,
		capturedAt: snapshot.capturedAt,
		charset: 'UTF-8',
		htmlFile: fileName,
		htmlBytes: snapshot.htmlBytes,
		status: 'unchecked',
	};
	const onError = (error: Error) => { throw error; };
	await saveFile({ content: snapshot.html, fileName, mimeType: 'text/html', tabId, onError });
	await saveFile({ content: JSON.stringify(metadata, null, 2) + '\n', fileName: `${fileName}.json`, mimeType: 'application/json', tabId, onError });
}

// Called by the content script only for pages with rendered MathJax. The
// background targets the sender's top frame, never a page-supplied tab ID.
export async function captureDocumentWithMath(doc: Document): Promise<Document> {
	if (!doc.querySelector('mjx-container') || doc.documentElement.classList.contains('obsidian-reader-active')) return doc;
	try {
		const result = await browser.runtime.sendMessage({ action: 'captureMathSnapshot' }) as SnapshotResult | undefined;
		if (!result || !('snapshot' in result)) return doc;
		const original = new URL(doc.URL), captured = new URL(result.snapshot.url);
		original.hash = captured.hash = '';
		if (original.href !== captured.href) return doc;
		const snapshot = new DOMParser().parseFromString(result.snapshot.html, 'text/html');
		Object.defineProperty(snapshot, 'URL', { value: doc.URL });
		return snapshot;
	} catch { return doc; } // Unrecoverable math still fails the preservation check.
}
