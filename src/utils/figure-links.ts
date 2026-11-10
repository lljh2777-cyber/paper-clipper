import { fromMarkdown } from 'mdast-util-from-markdown';
import type { RootContent } from 'mdast';

function absolute(value: string | null, source: string): string {
	if (!value) return '';
	try {
		const url = new URL(value, source);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
		url.hash = '';
		return url.href;
	} catch { return ''; }
}

function markdownImages(markdown: string, source: string): Set<string> {
	const nodes: RootContent[] = [];
	const walk = (node: RootContent) => {
		nodes.push(node);
		if ('children' in node) node.children.forEach(child => walk(child as RootContent));
	};
	fromMarkdown(markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')).children.forEach(walk);
	const definitions = new Map<string, string>();
	for (const node of nodes) if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
	return new Set(nodes.flatMap(node => node.type === 'image' ? [absolute(node.url, source)] :
		node.type === 'imageReference' ? [absolute(definitions.get(node.identifier) ?? '', source)] : []).filter(Boolean));
}

function declaredImages(figure: Element, source: string): Set<string> {
	const values: string[] = [];
	for (const element of Array.from(figure.querySelectorAll('img, picture > source'))) {
		for (const attr of ['src', 'data-src']) values.push(absolute(element.getAttribute(attr), source));
		for (const attr of ['srcset', 'data-srcset']) {
			// Split URL/descriptor pairs, retaining commas inside a URL. Reject
			// unfamiliar descriptors instead of inventing an image address.
			let remaining = element.getAttribute(attr) ?? '';
			while (remaining) {
				remaining = remaining.replace(/^[\s,]+/, '');
				const token = remaining.match(/^\S+/)?.[0];
				if (!token) break;
				remaining = remaining.slice(token.length);
				let descriptor = '';
				if (!token.endsWith(',')) {
					const comma = remaining.indexOf(',');
					descriptor = (comma < 0 ? remaining : remaining.slice(0, comma)).trim();
					remaining = comma < 0 ? '' : remaining.slice(comma + 1);
				}
				if (descriptor && !/^(?:\d+w|(?:\d+(?:\.\d+)?|\.\d+)x)\s*$/.test(descriptor)) continue;
				values.push(absolute(token.replace(/,+$/, ''), source));
			}
		}
	}
	return new Set(values.filter(Boolean));
}

// Use explicit DOM associations and the images actually in the edited Markdown;
// never infer figure numbers from image order or guess CDN filenames.
export function collectFigureLinks(document: Document, source: string, markdown: string): Record<string, string> {
	const page = absolute(source, source);
	if (!page) return {};
	const images = markdownImages(markdown, source);
	const idCounts = new Map<string, number>();
	for (const element of Array.from(document.querySelectorAll('[id]'))) idCounts.set(element.id, (idCounts.get(element.id) ?? 0) + 1);
	const candidates = new Map<string, Set<string>>();
	const add = (url: string, image: string) => {
		const values = candidates.get(url) ?? new Set<string>();
		values.add(image); candidates.set(url, values);
	};
	const nature = /(^|\.)nature\.com$/.test(new URL(page).hostname);
	const selector = nature ? 'figure, .c-article-supplementary__item:has(h3 a[data-supp-info-image])' : 'figure';
	for (const figure of Array.from(document.querySelectorAll(selector))) {
		if (figure.querySelectorAll('img').length > 1) continue;
		const declared = declaredImages(figure, source);
		const extended = nature ? figure.querySelector('h3 a[data-supp-info-image]') : null;
		if (extended) declared.add(absolute(extended.getAttribute('data-supp-info-image'), source));
		const matches = [...declared].filter(url => images.has(url));
		if (matches.length !== 1) continue;
		for (const element of [figure, ...Array.from(figure.querySelectorAll('[id]'))]) {
			if (!element.id || idCounts.get(element.id) !== 1) continue;
			const url = new URL(page); url.hash = element.id;
			add(url.href, matches[0]);
		}
		// Extended figures use a separate figure page as well as an article ID.
		if (extended?.getAttribute('href')) {
			const target = absolute(extended.getAttribute('href'), source);
			if (target.startsWith(`${page.replace(/\/$/, '')}/figures/`)) add(target, matches[0]);
		}
	}
	return Object.fromEntries([...candidates].filter(([, values]) => values.size === 1).map(([url, values]) => [url, [...values][0]]));
}
