import { Marked } from 'marked';
import { parseHTML } from 'linkedom';
import { checkFigureCaptions } from './paper-captions.mjs';
import { checkSourceSections } from './paper-sections.mjs';
import { assessPaperIdentity, normalizeDoi } from './paper-metadata.mjs';

const marked = new Marked({ gfm: true });
export const bodyCheckVersion = 'markdown-sections-v2';
export const qualityVersion = 'paper-quality-v2';
export const reviewSectionRule = 'nature-review-source-v1';
export const previewPattern = /this is a preview of subscription content|sign in to access (?:the )?full (?:text|article)|purchase access to (?:the|this) article/i;
const mainPattern = /^(?:introduction|background|main|results|discussion|methods|materials and methods|methodology|conclusions?)(?:$|[\s:])/i;
const excludedPattern = /^(?:abstract|references?|bibliography|acknowledg(?:e)?ments?|funding|author(?:s|['\u2019]s)?[\s\u2019']+(?:contributions?|information|details)|declarations|ethics declarations|competing interests|conflicts? of interest|data availability|availability of data|code availability|supplementary|supporting information|additional information|peer review information|publisher['\u2019]s note|copyright|rights and permissions|about this article|article information)(?:$|[\s:])/i;
const referencePattern = /^(?:references?|bibliography)(?:$|[\s:])/i;
const words = value => value.trim().split(/\s+/).filter(Boolean).length;
const unnumbered = value => value.replace(/^\d+(?:\.\d+)*[.)]?\s*/, '');
const canonical = value => value.replace(/\s+/g, ' ').trim().toLowerCase();

export function inspectHtml(html, finalUrl) {
	const { document } = parseHTML(html);
	let contentUrl = finalUrl;
	const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
	if (canonical) {
		try {
			const url = new URL(canonical, finalUrl);
			const actual = new URL(finalUrl);
			if (url.origin === actual.origin && url.pathname === actual.pathname) contentUrl = url.href;
		} catch { /* Ignore malformed publisher metadata. */ }
	}
	for (const element of document.querySelectorAll('script, style, noscript, template, [hidden], [aria-hidden="true"]')) element.remove();
	const title = document.title;
	const unrenderedEquations = /(^|\.)frontiersin\.org$/.test(new URL(finalUrl).hostname) &&
		[...document.querySelectorAll('a.ArticleReference[href^="#e"]')].some(link => {
			const id = link.getAttribute('href').slice(1);
			return /^e\d+$/.test(id) && !document.getElementById(id);
		});
	return { contentUrl, title, unrenderedEquations,
		preview: previewPattern.test((document.body?.textContent ?? '').replace(/\s+/g, ' ')),
		challenge: /^(?:just a moment|access denied|attention required|client challenge|verify (?:you are|you're) human|security (?:check|verification))/i.test(title.trim()) };
}

// A fresh archive request may strengthen, but must not silently weaken, the
// requirements under which the retained extraction was accepted.
export function archiveRequirements(saved = {}, current = {}) {
	const validate = checks => {
		if (checks.minWords !== undefined && (!Number.isSafeInteger(checks.minWords) || checks.minWords < 1)) throw new Error('Invalid saved/current minWords.');
		if (checks.requiredSections !== undefined && (!Array.isArray(checks.requiredSections) || checks.requiredSections.some(value => typeof value !== 'string' || !value.trim()))) throw new Error('Invalid saved/current requiredSections.');
	};
	validate(saved);
	validate(current);
	const savedDoi = saved.expectedDoi ? normalizeDoi(saved.expectedDoi) : undefined;
	const currentDoi = current.expectedDoi ? normalizeDoi(current.expectedDoi) : undefined;
	if (savedDoi && currentDoi && savedDoi !== currentDoi) throw Object.assign(new Error('Saved and current expected DOI conflict.'), {
		code: 'paper-identity', quality: { version: qualityVersion, passed: false, reasons: ['paper-identity'],
			paperIdentity: { status: 'failed', expected: currentDoi, savedExpected: savedDoi, reason: 'conflicting-requested-dois' },
			completeness: { status: 'unchecked', reasons: [] }, preservation: { status: 'unverified' }, coverage: { status: 'not-run' } },
	});
	return { minWords: Math.max(saved.minWords ?? 1000, current.minWords ?? 0),
		requiredSections: [...new Set([...(saved.requiredSections ?? []), ...(current.requiredSections ?? [])])],
		...((currentDoi ?? savedDoi) ? { expectedDoi: currentDoi ?? savedDoi } : {}) };
}

export function assessPaper(html, markdown, url, checks, page = inspectHtml(html, url)) {
	const figureCaptions = checkFigureCaptions(html, markdown, url);
	const sourceSections = checkSourceSections(html, markdown, url);
	const paperIdentity = checks.expectedDoi ? assessPaperIdentity(html, checks.expectedDoi) : undefined;
	const reviewStructure = assessReviewStructure(html, sourceSections, checks.minWords);
	const quality = assessMarkdown(markdown, checks, { ...page, figureCaptions, sourceSections, paperIdentity, reviewStructure });
	const comparisons = { figureCaptions: figureCaptions.status, sourceSections: sourceSections.status };
	const applicable = Object.values(comparisons).some(status => status !== 'not-applicable');
	const contentReasons = quality.reasons.filter(reason => !['figure-captions', 'source-sections', 'paper-identity'].includes(reason));
	return { ...quality, version: qualityVersion,
		completeness: { status: contentReasons.length ? 'failed' : 'passed-heuristics', reasons: contentReasons },
		preservation: { status: Object.values(comparisons).includes('failed') ? 'failed' : applicable ? 'passed-within-scope' : 'unverified' },
		coverage: { status: applicable ? 'partial-source' : 'heuristic-only', comparisons,
			skippedParagraphs: sourceSections.skippedParagraphs,
			limitations: ['Heuristic checks do not prove full-text completeness.',
				'Only applicable figure-legend and plain-prose source comparisons are verified.',
				'Math, tables, lists, references, unloaded content and unsupported layouts are not fully compared.'] } };
}

function assessReviewStructure(html, source, minWords) {
	if (source.publisher !== 'nature') return undefined;
	const document = parseHTML(html).document;
	const types = [...document.querySelectorAll('head meta[name]')]
		.filter(meta => meta.getAttribute('name').toLowerCase() === 'dc.type')
		.map(meta => canonical(meta.getAttribute('content') ?? ''));
	if (!types.length || !types.every(type => type === 'reviewpaper')) return undefined;
	const reasons = [];
	if (source.status !== 'passed') reasons.push('source-sections-not-verified');
	if (source.expectedSections !== 1 || canonical(source.sections[0]?.heading ?? '') !== 'main') reasons.push('not-single-main-source');
	if (source.skippedParagraphs || source.checkedParagraphs < 2 || source.matchedParagraphs !== source.checkedParagraphs) reasons.push('source-prose-not-fully-compared');
	if (source.matchedWords < minWords) reasons.push('insufficient-matched-source-prose');
	return { rule: reviewSectionRule, status: reasons.length ? 'failed' : 'passed', reasons,
		articleType: 'ReviewPaper', requiredWords: minWords, matchedWords: source.matchedWords };
}

export function withOutputQuality(extraction, output) {
	return { ...extraction, passed: extraction.passed && output.passed,
		reasons: [...extraction.reasons, ...output.reasons.map(reason => `output-${reason}`)],
		outputQuality: output, outputFigureCaptions: output.figureCaptions, outputSourceSections: output.sourceSections,
		completeness: { status: [extraction, output].some(check => check.completeness.status === 'failed') ? 'failed' : 'passed-heuristics',
			reasons: [...extraction.completeness.reasons, ...output.completeness.reasons.map(reason => `output-${reason}`)] },
		preservation: { status: [extraction, output].some(check => check.preservation.status === 'failed') ? 'failed' : output.preservation.status },
		coverage: output.coverage };
}

export function qualitySummary(quality) {
	if (!quality?.completeness) return 'Completeness: unchecked; preservation: unverified; coverage: not-run.';
	return `Completeness: ${quality.completeness.status}; preservation: ${quality.preservation.status}; coverage: ${quality.coverage.status}. Not proof of full text.`;
}

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
	const sourceBackedReview = page.reviewStructure?.status === 'passed' && main.length === 1 &&
		mainSections.length === 1 && canonical(mainSections[0]) === 'main';
	if (mainSections.length < 2 && !sourceBackedReview) reasons.push('missing-main-sections');
	for (const section of main.filter(section => !section.words)) reasons.push(`empty-main-section:${section.heading}`);
	for (const heading of requiredSections) {
		const matches = eligible.filter(section => canonical(section.heading) === canonical(heading));
		if (!matches.length) reasons.push(`missing-section:${heading}`);
		else if (matches.some(section => !section.words)) reasons.push(`empty-section:${heading}`);
	}
	return { passed: reasons.length === 0, bodyCheck: bodyCheckVersion,
		bodyWords: words(body), wordsBeforeReferences: words(body.slice(0, referenceOffset)), mainBodyWords,
		headings: sections.map(section => section.heading), mainSections, sections, reasons,
		sectionRule: sourceBackedReview ? reviewSectionRule : 'two-main-sections',
		...(page.reviewStructure ? { reviewStructure: page.reviewStructure } : {}),
		...(page.figureCaptions ? { figureCaptions: page.figureCaptions } : {}),
		...(page.sourceSections ? { sourceSections: page.sourceSections } : {}),
		...(page.paperIdentity ? { paperIdentity: page.paperIdentity } : {}) };
}
