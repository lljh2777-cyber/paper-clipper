import { Marked } from 'marked';
import { parseHTML } from 'linkedom';

const marked = new Marked({ gfm: true });
export const bodyCheckVersion = 'markdown-sections-v1';
export const previewPattern = /this is a preview of subscription content|sign in to access (?:the )?full (?:text|article)|purchase access to (?:the|this) article/i;
const mainPattern = /^(?:introduction|background|main|results|discussion|methods|materials and methods|methodology|conclusions?)(?:$|[\s:])/i;
const excludedPattern = /^(?:abstract|references?|bibliography|acknowledg(?:e)?ments?|funding|author(?:s|['\u2019]s)?[\s\u2019']+(?:contributions?|information|details)|declarations|ethics declarations|competing interests|conflicts? of interest|data availability|availability of data|code availability|supplementary|supporting information|additional information|peer review information|publisher['\u2019]s note|copyright|rights and permissions|about this article|article information)(?:$|[\s:])/i;
const referencePattern = /^(?:references?|bibliography)(?:$|[\s:])/i;
const words = value => value.trim().split(/\s+/).filter(Boolean).length;
const unnumbered = value => value.replace(/^\d+(?:\.\d+)*[.)]?\s*/, '');
const canonical = value => value.replace(/\s+/g, ' ').trim().toLowerCase();

function visibleText(inline) {
	const document = parseHTML(`<html><body>${marked.parseInline(inline)}</body></html>`).document;
	for (const element of document.querySelectorAll('script, style, template, noscript, pre, code, math, img, [hidden], [aria-hidden="true"]')) element.remove();
	return document.body.textContent.replace(/\[\^[^\]\n]+\]/g, '').replace(/\s+/g, ' ').trim();
}

function proseBlocks(token) {
	if (token.type === 'list') return token.items.flatMap(item => item.tokens.flatMap(proseBlocks));
	if (!['paragraph', 'text'].includes(token.type)) return [];
	const text = token.text.trim();
	if (/^\[\^[^\]\n]+\]:/.test(text) || /^\$\$(?:(?!\$\$)[\s\S])*\$\$$/.test(text)) return [];
	const visible = visibleText(text);
	return /[\p{L}\p{N}]/u.test(visible) ? [visible] : [];
}

export function assessMarkdown(markdown, { minWords, requiredSections = [] }, page = {}) {
	if (!Number.isSafeInteger(minWords) || minWords < 1) throw new Error('minWords must be a positive integer.');
	const body = markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trimEnd();
	const tokens = marked.lexer(body);
	const sections = [];
	const stack = [];
	let mainBodyWords = 0;
	let cursor = 0;
	let referenceOffset = body.length;
	for (const token of tokens) {
		const start = body.indexOf(token.raw, cursor);
		if (start >= 0) cursor = start + token.raw.length;
		if (token.type === 'heading') {
			while (stack.length && stack.at(-1).level >= token.depth) stack.pop();
			const heading = visibleText(token.text);
			const label = unnumbered(heading);
			const kind = excludedPattern.test(label) ? 'excluded' : mainPattern.test(label) ? 'main' : 'other';
			const excluded = kind === 'excluded' || stack.some(section => section.excluded);
			const section = { heading, level: token.depth, kind, excluded, words: 0, paragraphs: 0 };
			sections.push(section);
			stack.push(section);
			if (referencePattern.test(label) && start >= 0) referenceOffset = Math.min(referenceOffset, start);
			continue;
		}
		if (!stack.length || stack.some(section => section.excluded)) continue;
		for (const text of proseBlocks(token)) {
			const count = words(text);
			// Descendant prose belongs to its containing sections, but contributes to
			// the overall body threshold only once, even for nested main headings.
			for (const section of stack) { section.words += count; section.paragraphs++; }
			if (stack.some(section => section.kind === 'main')) mainBodyWords += count;
		}
	}
	const eligible = sections.filter(section => !section.excluded);
	const main = eligible.filter(section => section.kind === 'main');
	const mainSections = [...new Map(main.filter(section => section.words > 0).map(section => [canonical(section.heading), section.heading])).values()];
	const reasons = [];
	if (page.preview || previewPattern.test(body)) reasons.push('subscription-preview');
	if (page.challenge) reasons.push('access-challenge');
	if (page.unrenderedEquations) reasons.push('unrendered-equations');
	if (page.figureCaptions?.status === 'failed') reasons.push('figure-captions');
	if (page.sourceSections?.status === 'failed') reasons.push('source-sections');
	if (page.paperIdentity?.status === 'failed') reasons.push('paper-identity');
	if (mainBodyWords < minWords) reasons.push('too-short');
	if (mainSections.length < 2) reasons.push('missing-main-sections');
	for (const section of main.filter(section => !section.words)) reasons.push(`empty-main-section:${section.heading}`);
	for (const heading of requiredSections) {
		const matches = eligible.filter(section => canonical(section.heading) === canonical(heading));
		if (!matches.length) reasons.push(`missing-section:${heading}`);
		else if (matches.some(section => !section.words)) reasons.push(`empty-section:${heading}`);
	}
	return { passed: reasons.length === 0, bodyCheck: bodyCheckVersion,
		bodyWords: words(body), wordsBeforeReferences: words(body.slice(0, referenceOffset)), mainBodyWords,
		headings: sections.map(section => section.heading), mainSections, sections, reasons,
		...(page.figureCaptions ? { figureCaptions: page.figureCaptions } : {}),
		...(page.sourceSections ? { sourceSections: page.sourceSections } : {}),
		...(page.paperIdentity ? { paperIdentity: page.paperIdentity } : {}) };
}
