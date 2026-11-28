import { preprintFigureSelector, preprintFigureSource, isHighWirePreprintHost } from './image-sources.mjs';
import { isExtendedPaperLabel } from './extended-paper-content';

export const preprintArticleSelector = '.article.fulltext-view';
const tableSelector = '.table.pos-float';

function appendCaption(target: Element, caption: Element, labelSelector: string) {
	const title = target.ownerDocument.createElement('p');
	for (const label of Array.from(caption.children).filter(child => child.matches(`${labelSelector}, .caption-title`))) {
		if (title.hasChildNodes()) title.append(' ');
		title.append(label);
	}
	if (title.hasChildNodes()) target.append(title);
	for (const node of Array.from(caption.childNodes)) {
		if (node.nodeType === 1 && (node as Element).matches('.caption-clear')) continue;
		if (node.nodeType !== 3 || node.textContent?.trim()) target.append(node);
	}
}

export function prepareHighWirePreprint(document: Document, url: string): void {
	const article = document.querySelector(preprintArticleSelector)!;
	// Keep the publisher's reference labels when generic footnote processing
	// would otherwise drop figure links or renumber citations.
	for (const link of Array.from(article.querySelectorAll('a.xref-fig[href], a.xref-table[href], a.xref-bibr[href]'))) {
		const target = link.getAttribute('href')!;
		if (!/^#(?:[FT]\d+|ref-\d+)$/.test(target)) continue;
		link.setAttribute('href', new URL(target, url).href);
		link.classList.remove('xref-fig', 'xref-table', 'xref-bibr');
	}
	// The numbered links now point to the source page. Removing its navigation
	// backlinks keeps the reference list from being treated as footnote definitions.
	for (const link of Array.from(article.querySelectorAll('.ref-list a.rev-xref-ref[id^="ref-"]'))) link.remove();
	for (const source of Array.from(article.querySelectorAll(preprintFigureSelector))) {
		const caption = source.querySelector('.fig-caption');
		if (!caption) continue;
		// A standalone image keeps its alt label without Defuddle promoting it
		// to a duplicate caption or flattening the rich legend into plain text.
		const figure = document.createElement('p');
		if (source.id) figure.id = source.id;
		const src = preprintFigureSource(source, url);
		if (src) {
			const image = document.createElement('img');
			image.setAttribute('src', src);
			image.setAttribute('alt', caption.querySelector('.fig-label')?.textContent?.trim() ?? '');
			figure.append(image);
		}
		const legend = document.createElement('div');
		appendCaption(legend, caption, '.fig-label');
		source.replaceWith(figure, legend);
	}
	for (const source of Array.from(article.querySelectorAll(tableSelector))) {
		const caption = source.querySelector('.table-caption');
		if (!caption) continue;
		const group = document.createElement('div');
		if (source.id) group.id = source.id;
		appendCaption(group, caption, '.table-label');
		for (const control of Array.from(source.querySelectorAll('.table-inline > .callout'))) control.remove();
		if (source.querySelector('table tr')) {
			caption.remove();
			group.append(...Array.from(source.childNodes));
		} else if (source.id) {
			const target = new URL(url);
			target.hash = source.id;
			const link = document.createElement('a');
			link.href = target.href;
			link.textContent = 'Open source table';
			const line = document.createElement('p');
			line.append(link);
			group.append(line);
		}
		source.replaceWith(group);
	}
	const content = document.createElement('article');
	content.append(...Array.from(article.childNodes));
	document.body.replaceChildren(content);
}

export async function expandHighWirePreprintTables(document: Document, source: string, scope: 'all' | 'body' | 'extended' = 'all'): Promise<Document> {
	let page: URL;
	try { page = new URL(source); } catch { return document; }
	if (!isHighWirePreprintHost(page.hostname) || !/^https?:$/.test(page.protocol)) return document;
	const selector = `${preprintArticleSelector} ${tableSelector}`;
	const tables = Array.from(document.querySelectorAll(selector));
	let output = document;
	let signal: AbortSignal | undefined;
	for (const [index, box] of tables.entries()) {
		const extended = isExtendedPaperLabel(box.querySelector('.table-caption')?.textContent);
		if (scope !== 'all' && extended !== (scope === 'extended')) continue;
		const path = box.querySelector('.table-expand-inline[data-table-url]')?.getAttribute('data-table-url');
		if (!path || box.querySelector('table tr')) continue;
		try {
			const url = new URL(path, page);
			if (url.origin !== page.origin || url.username || url.password || !/^\/highwire\/markup\/\d+\/expansion$/.test(url.pathname) ||
				url.searchParams.get('table-expand-inline') !== '1') continue;
			signal ??= AbortSignal.timeout(4500);
			if (signal.aborted) break;
			const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', signal });
			if (response.status === 429) break;
			if (!response.ok) continue;
			const fragment = new DOMParser().parseFromString(await response.text(), 'text/html');
			const table = fragment.querySelector('table');
			if (!table?.querySelector('tr') || fragment.querySelectorAll('table').length !== 1) continue;
			if (output === document) output = document.cloneNode(true) as Document;
			output.querySelectorAll(selector)[index].append(output.importNode(table, true));
		} catch { /* Keep the source table link when the publisher cannot provide the markup. */ }
	}
	return output;
}

export async function readHighWireExtendedTables(document: Document, source: string) {
	const expanded = await expandHighWirePreprintTables(document, source, 'extended');
	return Array.from(expanded.querySelectorAll(`${preprintArticleSelector} ${tableSelector}[id]`)).flatMap(box => {
		const table = box.querySelector('table');
		if (!table?.querySelector('tr') || !isExtendedPaperLabel(box.querySelector('.table-caption')?.textContent)) return [];
		const url = new URL(source);
		url.hash = box.id;
		return [{ url: url.href, html: table.outerHTML }];
	});
}
