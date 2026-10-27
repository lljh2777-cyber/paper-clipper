import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Root, RootContent, Definition } from 'mdast';
import { checkMathPreservation } from './paper-math.mjs';
import { cellCitation, cellCaptionForCheck } from './cell-citations.mjs';
import { ManualCheck as Check, ManualChecks as Checks, ManualExportChecks, ManualExportCheckContext,
	manualCheckLimitations, markdownSha256, unassessedManualExportChecks } from './manual-export-report';

export interface ManualExportSnapshot {
	document: Document;
	source: string;
	extractedMarkdown: string;
	templateMarkdown: string;
}

const bodyOnly = (value: string) => value.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
const canonical = (value: string) => value.replace(/\[\^(\d+)\]/g, '$1').replace(/\s+/g, '');
function text(node: Root | RootContent): string {
	if (node.type === 'text') return node.value;
	if (['code', 'inlineCode', 'html', 'image', 'imageReference', 'definition'].includes(node.type)) return '';
	return 'children' in node ? node.children.map(child => text(child as RootContent)).join('') : '';
}
function walk(node: Root | RootContent): RootContent[] {
	return 'children' in node ? node.children.flatMap(child => [child as RootContent, ...walk(child as RootContent)]) : [];
}
function absolute(value: string, source: string): string {
	try { return new URL(value, source).href; } catch { return ''; }
}
function markdownView(markdown: string, source: string) {
	const body = bodyOnly(markdown).replace(/\r\n?/g, '\n');
	const tree = fromMarkdown(body);
	const nodes = walk(tree);
	const definitions = new Map<string, Definition>();
	for (const node of nodes) if (node.type === 'definition') definitions.set(node.identifier, node);
	const targetUrl = (node: RootContent) => {
		const target = node.type === 'link' || node.type === 'image' ? node :
			node.type === 'linkReference' || node.type === 'imageReference' ? definitions.get(node.identifier) : undefined;
		return target ? absolute(target.url, source) : '';
	};
	const links = (node: Root | RootContent) => walk(node).map(targetUrl).filter(Boolean);
	const raw = (node: RootContent) => body.slice(node.position!.start.offset, node.position!.end.offset);
	// The converter emits numeric footnotes. Parse their rich contents separately;
	// code blocks and unindented following prose must never satisfy a definition.
	const footnotes = new Map<string, { text: string; links: string[] }[]>();
	for (const node of tree.children) {
		if (node.type !== 'paragraph' && node.type !== 'definition') continue;
		for (const match of raw(node).matchAll(/^\[\^(\d+)\]:([^\n]*(?:\n(?: {4}|\t)[^\n]*)*)/gm)) {
			const parsed = fromMarkdown(match[2].replace(/\n(?: {4}|\t)/g, '\n').trim());
			const entries = footnotes.get(match[1]) ?? [];
			entries.push({ text: canonical(text(parsed)), links: links(parsed) });
			footnotes.set(match[1], entries);
		}
	}
	const blocks = tree.children.map(node => ({ type: node.type, text: canonical(text(node)), raw: raw(node), links: links(node), node }));
	return { blocks, footnotes, targetUrl };
}

const uncovered = (scope: string, reason = 'no-supported-source-elements'): Check => ({
	status: 'not-covered', scope, expected: 0, matched: 0, issues: [], reason,
});
function checked(scope: string, results: { id: string; reason?: string; notCovered?: boolean }[]): Check {
	if (!results.length) return uncovered(scope);
	const issues = results.filter((item): item is { id: string; reason: string } => !!item.reason);
	return { status: results.some(item => item.reason && !item.notCovered) ? 'failed' : issues.length ? 'not-covered' : 'passed',
		scope, expected: results.length, matched: results.length - issues.length, issues };
}
function sourceLinks(element: Element, url: string): string[] {
	return Array.from(element.querySelectorAll('a[href]')).map(link => absolute(link.getAttribute('href')!, url));
}
function hasLinks(element: Element, block: ReturnType<typeof markdownView>['blocks'][number], view: ReturnType<typeof markdownView>, url: string, references = new Map<string, string>()): boolean {
	return sourceLinks(element, url).every(href => {
		if (!href) return false;
		if (block.links.includes(href)) return true;
		const target = new URL(href), article = new URL(url);
		const number = target.origin === article.origin && target.pathname === article.pathname
			? target.hash.match(/^#ref-CR(\d+)$/)?.[1] ?? references.get(target.hash.slice(1)) : undefined;
		return !!number && block.raw.includes(`[^${number}]`) && view.footnotes.get(number)?.length === 1 && !!view.footnotes.get(number)![0].text;
	});
}

function inspect(snapshot: ManualExportSnapshot, markdown: string): Checks {
	const { document, source } = snapshot;
	const host = new URL(source).hostname;
	const cell = /(^|\.)cell\.com$/.test(host), nature = /(^|\.)nature\.com$/.test(host);
	const view = markdownView(markdown, source);
	// Tables with merged cells remain HTML. Read only visible table citations,
	// not arbitrary HTML/code that could hide a missing prose reference.
	const tableUses: string[] = [], tableText: string[] = [];
	for (const block of view.blocks.filter(block => block.type === 'html')) {
		const fragment = document.createElement('template');
		fragment.innerHTML = block.raw;
		const table = fragment.content.firstElementChild;
		if (fragment.content.children.length !== 1 || !table?.matches('table') || table.matches('[hidden], [aria-hidden="true"], [style]') ||
			Array.from(fragment.content.childNodes).some(node => node.nodeType === 3 && node.textContent?.trim())) continue;
		table.querySelectorAll('pre, code, script, style, template, [hidden], [aria-hidden="true"], [style]').forEach(node => node.remove());
		for (const link of Array.from(table.querySelectorAll('sup > a[href]'))) {
			const number = link.getAttribute('href')?.match(/^#fn:(\d+)$/)?.[1];
			if (number && link.textContent?.trim() === number) {
				tableUses.push(number);
				link.replaceWith(document.createTextNode(`[^${number}]`));
			}
		}
		tableText.push(table.textContent ?? '');
	}
	const entries = cell ? Array.from(document.querySelectorAll('.biblioentry .citations[id]')).filter(entry => /^bib\d+$/.test(entry.id)) : [];
	const referenceNumbers = new Map<string, string>();
	for (const entry of entries) {
		const copy = entry.cloneNode(true) as Element;
		copy.querySelector('.citation-content > .label')?.remove();
		if (!copy.querySelector('.citation-content')) continue;
		const expected = canonical(copy.textContent ?? '');
		const matches = [...view.footnotes.entries()].filter(([, definitions]) => definitions.length === 1 && definitions[0].text === expected &&
			sourceLinks(copy, source).every(link => definitions[0].links.includes(link)));
		if (expected && matches.length === 1) referenceNumbers.set(entry.id, matches[0][0]);
	}
	const captionScope = 'cell-nature-caption-paragraphs-links-order-v1';
	const captions = cell || nature ? checked(captionScope, Array.from(document.querySelectorAll(cell
		? 'figure.graphic figcaption .figure__caption__text__content' : 'figure .c-article-section__figure-description')).map((legend, i) => {
		const figure = legend.closest('figure')!;
		const id = `figure-${i + 1}`;
		const title = canonical(figure.querySelector(cell ? '.figure__title' : 'figcaption')?.textContent ?? '');
		const titles = view.blocks.flatMap((block, index) => block.type === 'paragraph' && block.text === title ? [index] : []);
		const paragraphs = Array.from(legend.querySelectorAll(cell ? 'p, [role="paragraph"]' : 'p'));
		if (!title || !paragraphs.length) return { id, reason: 'unsupported-source-caption-structure', notCovered: true };
		if (titles.length !== 1) return { id, reason: 'missing-or-ambiguous-caption-title' };
		const intact = paragraphs.every((paragraph, index) => {
			const block = view.blocks[titles[0] + index + 1];
			const scientific = cell ? cellCaptionForCheck(paragraph, referenceNumbers) : paragraph;
			const expected = canonical(scientific.textContent ?? '');
			return !!expected && block?.type === 'paragraph' && block.text === expected && hasLinks(scientific, block, view, source, referenceNumbers);
		});
		return { id, ...(!intact && { reason: 'caption-text-link-or-order-differs' }) };
	})) : uncovered(captionScope, 'unsupported-publisher');

	const referenceScope = 'cell-bibliography-labels-and-inline-counts-v2';
	const references = cell ? checked(referenceScope, entries.map((entry, i) => {
		const id = `reference-${i + 1}`;
		const copy = entry.cloneNode(true) as Element;
		copy.querySelector('.citation-content > .label')?.remove();
		if (!copy.querySelector('.citation-content')) return { id, reason: 'unsupported-bibliography-structure', notCovered: true };
		const number = referenceNumbers.get(entry.id);
		if (!number) return { id, reason: 'missing-changed-or-duplicate-definition' };
		const controls = Array.from(document.querySelectorAll('.reference-citations a.reference-citations__ctrl[data-xml-rid]')).filter(link => link.getAttribute('data-xml-rid') === entry.id);
		const expectedTableUses = controls.filter(link => link.closest('table')).length;
		// Use Markdown text (not canonical text, which normalizes citation markers).
		const actualUses = view.blocks.filter(block => !/^\[\^\d+\]:/.test(block.raw) && !['code', 'html'].includes(block.type))
			.reduce((sum, block) => sum + (text(block.node).match(new RegExp(`\\[\\^${number}\\]`, 'g'))?.length ?? 0), 0);
		const actualTableUses = tableUses.filter(value => value === number).length;
		// Simple tables use Markdown; merged tables use HTML. Both contribute
		// to the total, but HTML cannot supply extra citations absent in source tables.
		if (actualUses + actualTableUses !== controls.length || actualTableUses > expectedTableUses) return { id, reason: 'inline-citation-count-differs' };
		const labels = new Map<string, number>();
		for (const wrapper of Array.from(document.querySelectorAll('.reference-citations'))) {
			const citation = cellCitation(wrapper);
			if (citation?.target === entry.id && citation.authorYear) {
				const label = citation.label.replace(/\s+/g, '');
				labels.set(label, (labels.get(label) ?? 0) + 1);
			}
		}
		const prose = [...view.blocks.filter(block => !/^\[\^\d+\]:/.test(block.raw) && !['code', 'html'].includes(block.type))
			.map(block => text(block.node)), ...tableText].map(value => value.replace(/\s+/g, '')).join('\n');
		// Consume longer labels first: a year-only citation must not also count
		// the year suffix of "Author, 2025" referencing the same paper.
		let remaining = prose;
		const intact = [...labels].sort((a, b) => b[0].length - a[0].length).every(([label, count]) => {
			const parts = remaining.split(`${label}[^${number}]`);
			remaining = parts.join('\n');
			return parts.length - 1 === count;
		});
		return { id, ...(!intact && { reason: 'author-year-citation-label-differs' }) };
	})) : uncovered(referenceScope, 'unsupported-publisher');

	const extendedScope = 'nature-declared-extended-images-v1';
	const extendedImages = nature ? checked(extendedScope, Array.from(document.querySelectorAll('.c-article-supplementary__item h3 a'))
		.filter(link => /^Extended Data Fig\.\s*\d+\b/i.test(link.textContent?.trim() ?? '')).map((link, i) => {
			const id = `extended-figure-${i + 1}`;
			const declared = link.getAttribute('data-supp-info-image');
			if (!declared) return { id, reason: 'source-image-address-unavailable', notCovered: true };
			const title = canonical(link.textContent ?? '');
			const titles = view.blocks.flatMap((block, index) => block.type === 'heading' && block.text === title ? [index] : []);
			const block = titles.length === 1 ? view.blocks[titles[0] + 1] : undefined;
			const images = block ? walk(block.node).filter(node => node.type === 'image' || node.type === 'imageReference') : [];
			return { id, ...(!images.some(image => view.targetUrl(image) === absolute(declared, source)) && { reason: 'declared-image-missing-or-not-after-heading' }) };
		})) : uncovered(extendedScope, 'unsupported-publisher');

	const math = checkMathPreservation(document, markdown);
	return { captions, references, extendedImages, math: math.status === 'not-applicable' ? uncovered(math.scope) : {
		status: math.status, scope: math.scope, expected: math.expected, matched: math.matched,
		issues: [...math.missing.map((_, i) => ({ id: `formula-missing-${i + 1}`, reason: 'formula-missing-or-changed' })),
			...math.unsupported.map((_, i) => ({ id: `formula-unsupported-${i + 1}`, reason: 'unsupported-source-formula' }))],
	} };
}

export function checkManualExport(snapshot: ManualExportSnapshot | undefined, output: string): ManualExportChecks {
	if (!snapshot) return unassessedManualExportChecks();
	const extraction = inspect(snapshot, snapshot.extractedMarkdown);
	const template = snapshot.templateMarkdown === snapshot.extractedMarkdown ? extraction : inspect(snapshot, snapshot.templateMarkdown);
	const final = output === snapshot.templateMarkdown ? template : inspect(snapshot, output);
	const all = [...Object.values(extraction), ...Object.values(template), ...Object.values(final)];
	return {
		schemaVersion: 1, completeness: 'not-assessed',
		preservation: all.some(check => check.status === 'failed') ? 'attention-required' : all.some(check => check.status === 'passed') ? 'passed-within-scope' : 'not-assessed',
		coverage: all.some(check => check.status !== 'not-covered') ? 'partial-source' : 'not-assessed',
		source: 'captured-page',
		changes: { template: snapshot.templateMarkdown === snapshot.extractedMarkdown ? 'unchanged' : 'changed',
			editor: output === snapshot.templateMarkdown ? 'unchanged' : 'changed' },
		stages: { extraction, template, output: final },
		limitations: [...manualCheckLimitations],
	};
}

export async function prepareManualExportChecks(snapshot: ManualExportSnapshot | undefined, markdown: string): Promise<ManualExportCheckContext> {
	return { inputSha256: await markdownSha256(markdown), report: checkManualExport(snapshot, bodyOnly(markdown)) };
}
