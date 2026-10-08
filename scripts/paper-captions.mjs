import { Marked } from 'marked';
import { parseHTML } from 'linkedom';

const marked = new Marked({ gfm: true });
const bodyOnly = value => value.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
// Citation superscripts may become Markdown footnote references. Ignore layout
// whitespace, but retain every letter, number and punctuation mark of the legend.
const canonicalText = value => value.replace(/\[\^(\d+)\]/g, '$1').replace(/\s+/g, '');
const rendered = value => parseHTML(`<html><body>${marked.parse(value)}</body></html>`).document;

export function checkFigureCaptions(html, markdown, url) {
	const result = { version: 1, status: 'not-applicable', publisher: null, expected: 0, matched: 0, failed: 0, figures: [] };
	if (!/(^|\.)nature\.com$/.test(new URL(url).hostname)) return { ...result, reason: 'unsupported-publisher' };
	result.publisher = 'nature';
	result.expected = parseHTML(html).document.querySelectorAll('figure .c-article-section__figure-description').length;
	if (!result.expected) return { ...result, reason: 'no-supported-legends' };
	try {
		// Marked normalizes line endings; this public check does not expose offsets.
		const audit = auditNatureLegends(html, markdown.replace(/\r\n?/g, '\n'), url);
		return { ...result, status: audit.passed ? 'passed' : 'failed', matched: audit.expected - audit.missing,
			failed: audit.missing, figures: audit.figures };
	} catch (error) {
		return { ...result, status: 'failed', failed: result.expected, error: `Cannot verify source legends: ${error.message}` };
	}
}

export function auditNatureLegends(html, markdown, url) {
	const source = parseHTML(html).document;
	const body = bodyOnly(markdown);
	const article = new URL(url);
	const definitions = new Set([...body.matchAll(/^\[\^(\d+)\]:\s*\S/gm)].map(match => match[1]));
	let cursor = 0;
	const tokens = marked.lexer(body).filter(token => token.type !== 'space').map(token => {
		const start = body.indexOf(token.raw, cursor);
		if (start < 0) throw new Error('Cannot locate caption token in the original Markdown.');
		cursor = start + token.raw.length;
		const document = rendered(token.raw);
		return { ...token, start, end: cursor, text: canonicalText(document.body.textContent), document };
	});
	const figures = [];
	const blocks = [];
	const descriptions = [...source.querySelectorAll('figure .c-article-section__figure-description')];
	for (const description of descriptions) {
		const title = description.closest('figure').querySelector('figcaption')?.textContent?.trim();
		const titles = tokens.map((token, index) => token.type === 'paragraph' && token.text === canonicalText(title ?? '') ? index : -1).filter(index => index >= 0);
		const paragraphs = [...description.querySelectorAll('p')];
		const item = { id: description.id, title, paragraphs: paragraphs.length, passed: false, errors: [] };
		if (!title || titles.length !== 1 || !paragraphs.length) item.errors.push('Expected one figure title and nonempty source paragraphs.');
		else for (const [index, paragraph] of paragraphs.entries()) {
			const expected = canonicalText(paragraph.textContent);
			const token = tokens[titles[0] + index + 1];
			if (!expected || token?.type !== 'paragraph' || token.text !== expected) {
				item.errors.push(`Paragraph ${index + 1} missing, changed or not directly after its figure.`);
				continue;
			}
			if (tokens.filter(entry => entry.type === 'paragraph' && entry.text === expected).length !== 1) item.errors.push(`Paragraph ${index + 1} duplicated.`);
			const links = [...token.document.querySelectorAll('a[href]')].map(link => new URL(link.getAttribute('href'), url).href);
			for (const link of paragraph.querySelectorAll('a[href]')) {
				const target = new URL(link.getAttribute('href'), url);
				const citation = target.origin === article.origin && target.pathname === article.pathname
					? target.hash.match(/^#ref-CR(\d+)$/)?.[1] : undefined;
				const footnote = citation && link.textContent.trim() === citation && definitions.has(citation) && token.raw.includes(`[^${citation}]`);
				if (!footnote && !links.includes(target.href)) item.errors.push(`Paragraph ${index + 1} lost a link or citation.`);
			}
			blocks.push({ id: description.id, title, text: expected, raw: token.raw, start: token.start, end: token.end });
		}
		item.passed = !item.errors.length;
		figures.push(item);
	}
	return { passed: figures.length > 0 && figures.every(item => item.passed), expected: figures.length,
		missing: figures.filter(item => !item.passed).length, figures, blocks };
}

export function compareWithoutAddedLegends(html, actual, legacy, url, expectedCount) {
	const audit = auditNatureLegends(html, actual, url);
	if (!audit.passed || audit.expected !== expectedCount) throw new Error('Source-backed figure legend additions did not pass the declared count/content checks.');
	const legacyText = canonicalText(rendered(bodyOnly(legacy)).body.textContent);
	if (audit.blocks.some(block => legacyText.includes(block.text))) throw new Error('Legacy reference already contains a declared missing legend.');
	let body = bodyOnly(actual);
	for (const block of [...audit.blocks].sort((a, b) => b.start - a.start)) {
		const end = block.end + (body.slice(block.end).match(/^\n{1,2}/)?.[0].length ?? 0);
		body = body.slice(0, block.start) + body.slice(end);
	}
	return { body, figures: audit.figures };
}
