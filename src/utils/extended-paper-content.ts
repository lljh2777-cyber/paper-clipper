import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Root, RootContent } from 'mdast';
import { isHighWirePreprintHost, preprintFigureSource } from './image-sources.mjs';

const compact = (text: string) => text.replace(/\s+/g, '').toLowerCase();
const extended = /^(?:extended\s+data\b|supplement(?:ary|al)\s+(?:fig(?:ure)?\.?|table)\b|(?:fig(?:ure)?\.?|table)\s+s\d)/i;
export const isExtendedPaperLabel = (label: string | null | undefined) => extended.test(label?.trim() ?? '');

function imageUrl(value: string, source: string): string {
	try {
		const url = new URL(value, source);
		if (!/^https?:$/.test(url.protocol) || url.username || url.password) return '';
		url.hash = '';
		return url.href;
	} catch { return ''; }
}

export function collectExtendedPaperContent(document: Document, source: string) {
	const images = new Set<string>();
	const mainImages = new Set<string>();
	const tables = new Map<string, string>();
	const page = new URL(source);
	const highWire = isHighWirePreprintHost(page.hostname);
	const figureSelector = highWire ? '.article.fulltext-view .fig.type-figure' : 'figure';
	for (const figure of Array.from(document.querySelectorAll(figureSelector))) {
		const label = (figure.querySelector(highWire ? '.fig-label' : 'figcaption')?.textContent ?? '').trim();
		const targets = extended.test(label) ? images : mainImages;
		const urls = highWire ? [preprintFigureSource(figure, page) ?? ''] : Array.from(figure.querySelectorAll('img')).flatMap(img =>
			['src', 'data-src'].map(attr => img.getAttribute(attr) ?? ''));
		for (const url of urls) {
			const address = url && imageUrl(url, source);
			if (address) targets.add(address);
		}
	}
	for (const link of Array.from(document.querySelectorAll('.c-article-supplementary__item h3 a[data-supp-info-image]'))) {
		const url = imageUrl(link.getAttribute('data-supp-info-image')!, source);
		if (url && extended.test(link.textContent?.trim() ?? '')) images.add(url);
	}
	for (const url of mainImages) images.delete(url);
	for (const box of Array.from(document.querySelectorAll(highWire ? '.article.fulltext-view .table.pos-float[id]' : '.c-article-table[id]'))) {
		const caption = box.querySelector(highWire ? '.table-caption' : 'figcaption')?.textContent?.trim();
		if (!caption || !extended.test(caption)) continue;
		const target = new URL(source);
		target.hash = box.id;
		const key = compact(caption);
		tables.set(key, tables.has(key) ? '' : target.href);
	}
	return { images, tables };
}

const markdownText = (node: Root | RootContent): string => node.type === 'text' ? node.value :
	'children' in node ? node.children.map(child => markdownText(child as RootContent)).join('') : '';

export function isStandalonePaperTable(raw: string): boolean {
	const rows = raw.trim().split(/\r?\n/);
	return /^<table(?:\s|>)[\s\S]*<\/table>\s*$/i.test(raw) ||
		(rows.length >= 2 && /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(rows[1]) && rows.every(line => /^\|.*\|\s*$/.test(line)));
}

export function excludeExtendedPaperContent(markdown: string, source: string, content: ReturnType<typeof collectExtendedPaperContent>, tableLinkLabel: string) {
	const frontmatter = markdown.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? '';
	let body = markdown.slice(frontmatter.length);
	const tree = fromMarkdown(body);
	const definitions = new Map(tree.children.flatMap(node => node.type === 'definition' ? [[node.identifier, node.url] as const] : []));
	const edits: { start: number; end: number; text: string }[] = [];
	const skippedImages = new Set<string>();
	const range = (node: RootContent) => ({ start: node.position!.start.offset!, end: node.position!.end.offset! });
	const escape = (label: string) => label.replace(/[\\[\]]/g, '\\$&');
	const link = (label: string, url: string) => `[${escape(label || tableLinkLabel)}](<${url}>)`;
	function visit(node: RootContent, insideLink = false) {
		const url = node.type === 'image' ? node.url : node.type === 'imageReference' ? definitions.get(node.identifier) : undefined;
		const address = url && imageUrl(url, source);
		if (address && content.images.has(address) && (node.type === 'image' || node.type === 'imageReference')) {
			skippedImages.add(address);
			const label = node.alt || new URL(address).pathname.split('/').pop() || address;
			edits.push({ ...range(node), text: insideLink ? escape(label) : link(label, address) });
		}
		if ('children' in node) node.children.forEach(child => visit(child as RootContent, insideLink || node.type === 'link' || node.type === 'linkReference'));
	}
	for (const [index, node] of tree.children.entries()) {
		const following = tree.children[index + 1];
		const table = (node.type === 'paragraph' || node.type === 'heading') && content.tables.get(compact(markdownText(node)));
		if (table && following && (following.type === 'html' || following.type === 'paragraph')) {
			const { start, end } = range(following);
			const raw = body.slice(start, end);
			if (isStandalonePaperTable(raw)) {
				edits.push({ start, end, text: link(tableLinkLabel, table) });
				continue;
			}
		}
		if (!edits.some(edit => edit.start === node.position?.start.offset)) visit(node);
	}
	for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
	return { markdown: frontmatter + body, skippedImages };
}

export function extendedTableLink(node: RootContent, source: string): string | undefined {
	if (node.type !== 'paragraph' || node.children.length !== 1) return;
	const child = node.children[0];
	if (child.type !== 'link' || markdownText(child) !== 'Open source table') return;
	try { return new URL(child.url, source).href; } catch { return; }
}

export function fillExtendedTableLinks(markdown: string, source: string, tables: Record<string, string>) {
	const frontmatter = markdown.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? '';
	let body = markdown.slice(frontmatter.length);
	const edits = fromMarkdown(body).children.flatMap(node => {
		const href = extendedTableLink(node, source);
		return href && Object.prototype.hasOwnProperty.call(tables, href) && tables[href].trim()
			? [{ start: node.position!.start.offset!, end: node.position!.end.offset!, text: tables[href] }] : [];
	});
	for (const edit of edits.reverse()) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
	return frontmatter + body;
}
