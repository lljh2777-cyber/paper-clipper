import { Marked } from 'marked';
import { parseHTML } from 'linkedom';

const marked = new Marked({ gfm: true });
export const sourceSectionsVersion = 'nature-sections-v1';
const excluded = 'figure, figcaption, table, ul, ol, blockquote, pre, script, style, template, noscript, [hidden], [aria-hidden="true"]';
const math = 'math, mjx-container, .mathjax-tex, .c-article-equation, [data-tex], [data-latex]';
const canonical = value => value.replace(/\s+/g, '');
const citationMarker = id => `{paper-citation:${id}}`;

function citationId(link, url) {
	const target = new URL(link.getAttribute('href'), url);
	const article = new URL(url);
	const id = target.origin === article.origin && target.pathname === article.pathname
		? target.hash.match(/^#ref-CR(\d+)$/)?.[1] : null;
	return id && link.textContent.trim() === id ? id : null;
}

function textOf(element, url, markdown = false) {
	const clone = element.cloneNode(true);
	for (const node of clone.querySelectorAll(excluded + ', img')) node.remove();
	// Clipper turns numeric Nature citation groups into adjacent footnote markers.
	// Normalize their separators only; keep each reference number distinct.
	for (const sup of clone.querySelectorAll('sup')) {
		const links = [...sup.querySelectorAll('a[href]')];
		if (links.length && [...sup.children].every(node => links.includes(node)) && links.every(link => citationId(link, url)) &&
			/^[\d\s,]+$/.test(sup.textContent)) sup.textContent = links.map(link => citationMarker(citationId(link, url))).join('');
	}
	for (const link of clone.querySelectorAll('a[href]')) {
		const id = citationId(link, url);
		if (id) link.textContent = citationMarker(id);
	}
	const text = markdown ? clone.textContent.replace(/\[\^(\d+)\]/g, (_, id) => citationMarker(id)) : clone.textContent;
	return canonical(text);
}

function markdownSections(markdown, url) {
	const body = markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').replace(/^\uFEFF/, '');
	const sections = [];
	for (const token of marked.lexer(body)) {
		if (!['heading', 'paragraph'].includes(token.type)) continue;
		if (token.type === 'paragraph' && /^\[\^[^\]\n]+\]:/.test(token.text)) continue;
		const document = parseHTML(`<html><body>${marked.parse(token.raw)}</body></html>`).document;
		const text = textOf(document.body, url, true);
		if (token.type === 'heading') sections.push({ text, level: token.depth, paragraphs: [] });
		else if (sections.length && text) sections.at(-1).paragraphs.push(text);
	}
	return sections;
}

function sourceSections(section, url) {
	const content = section.querySelector('.c-article-section__content');
	const heading = section.querySelector('.c-article-section__title');
	if (!content || !heading || !/^H[1-6]$/.test(heading.tagName) || heading.parentElement !== content.parentElement) {
		throw new Error('Unsupported source section structure.');
	}
	const sections = [];
	for (const element of [heading, ...content.querySelectorAll('h1, h2, h3, h4, h5, h6, p')]) {
		if (element.closest(excluded)) continue;
		if (element.tagName !== 'P') {
			sections.push({ heading: element.textContent.trim(), id: element.id || null,
				text: textOf(element, url), level: Number(element.tagName.slice(1)), paragraphs: [] });
		} else {
			if (!sections.length) throw new Error('Source paragraph has no supported heading.');
			const reason = element.querySelector(math) || /\\[([]|\$/.test(element.textContent) ? 'math-or-dollar-content'
				: element.querySelector('img') ? 'inline-image' : null;
			const text = textOf(element, url);
			if (text || reason) sections.at(-1).paragraphs.push({ text, reason });
		}
	}
	if (!sections.length || sections[0].text !== canonical(heading.textContent)) throw new Error('Source heading is not visible.');
	return sections;
}

export function checkSourceSections(html, markdown, url) {
	const result = { version: sourceSectionsVersion, status: 'not-applicable', publisher: null,
		scope: 'main-content headings and plain prose paragraphs', expectedSections: 0, checkedParagraphs: 0,
		matchedParagraphs: 0, skippedParagraphs: 0, sections: [] };
	try {
		if (!/(^|\.)nature\.com$/.test(new URL(url).hostname)) return { ...result, reason: 'unsupported-publisher' };
		result.publisher = 'nature';
		const document = parseHTML(html).document;
		const containers = document.querySelectorAll('.c-article-body .main-content');
		if (containers.length !== 1) return { ...result, reason: 'unsupported-source-structure' };
		const roots = [...containers[0].querySelectorAll(':scope > section[data-title]')];
		if (!roots.length) return { ...result, reason: 'no-supported-sections' };
		const actual = markdownSections(markdown, url);
		let lastRootEnd = 0;
		for (const root of roots) {
			const expected = sourceSections(root, url);
			const candidates = actual.map((entry, index) => entry.text === expected[0].text && entry.level === expected[0].level ? index : -1).filter(index => index >= 0);
			const start = candidates.length === 1 ? candidates[0] : -1;
			let end = start + 1;
			if (start >= 0) while (end < actual.length && actual[end].level > actual[start].level) end++;
			const found = start >= 0 ? actual.slice(start, end) : [];
			const ordered = start >= lastRootEnd;
			const structureMatches = found.length === expected.length && expected.every((entry, index) =>
				entry.text === found[index].text && entry.level - expected[0].level === found[index].level - found[0].level);
			if (start >= 0) lastRootEnd = end;
			for (const [index, section] of expected.entries()) {
				const item = { heading: section.heading, id: section.id, paragraphs: section.paragraphs.length,
					checked: 0, matched: 0, skipped: [], errors: [] };
				result.sections.push(item);
				if (!structureMatches) item.errors.push('missing-changed-duplicated-or-misnested-heading');
				if (!ordered) item.errors.push('section-order');
				const paragraphs = structureMatches ? found[index].paragraphs : [];
				let cursor = 0;
				for (const [paragraphIndex, paragraph] of section.paragraphs.entries()) {
					if (paragraph.reason) {
						item.skipped.push({ paragraph: paragraphIndex + 1, reason: paragraph.reason });
						result.skippedParagraphs++;
						continue;
					}
					item.checked++;
					result.checkedParagraphs++;
					const count = section.paragraphs.filter(entry => !entry.reason && entry.text === paragraph.text).length;
					const positions = paragraphs.map((text, i) => text === paragraph.text ? i : -1).filter(i => i >= 0);
					const position = positions.find(i => i >= cursor);
					if (positions.length !== count || position === undefined) item.errors.push(`paragraph:${paragraphIndex + 1}:missing-changed-duplicated-or-reordered`);
					else { cursor = position + 1; item.matched++; result.matchedParagraphs++; }
				}
			}
		}
		result.expectedSections = result.sections.length;
		result.status = result.sections.some(section => section.errors.length) ? 'failed' : 'passed';
		return result;
	} catch (error) {
		return { ...result, status: 'failed', error: `Cannot verify source sections: ${error.message}` };
	}
}
