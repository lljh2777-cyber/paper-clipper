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
