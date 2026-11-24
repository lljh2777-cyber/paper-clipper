// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import Defuddle from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';
import { clip } from '../api';
import { parseForClip } from './clip-utils';
import { prepareDocumentForExtraction } from './publisher-figures';
import { checkManualExport } from './manual-export-checks';
import type { Template } from '../types/types';
import { cellAuthorYearHtml, cellAuthorYearUrl } from '../../scripts/fixtures/cell-author-year.mjs';

const url = 'https://www.cell.com/cell/fulltext/synthetic-citations';
const paragraph = 'This synthetic study compares tissue neighborhoods and reports experimental observations. '.repeat(30);
const citation = (number: number, target = `bib${number}`, suffix = '', expanded = false) => `<span class="dropBlock reference-citations"><a
	id="body-ref-sref${number}${suffix}" href="#" role="button" data-xml-rid="${target}" href-manipulated="true"
	aria-label="Reference ${number}" class="reference-citations__ctrl" aria-expanded="${expanded}"
	data-db-target-for="sref${number}${suffix}" aria-controls="sref${number}${suffix}"><sup>${number}</sup></a><div
	class="dropBlock__holder" id="sref${number}${suffix}"><div class="dropBlock__body"><div class="citation-content">
	<div>${number}.</div><div>Preview-only synthetic author.</div><div><strong>Synthetic reference ${number}.</strong></div>
	</div><button>Close preview</button></div></div></span>`;
const reference = (number: number, target = `bib${number}`) => `<div class="biblioentry"><div id="${target}" class="citations">
	<div class="citation"><div class="citation-content"><div class="label"><a href="#body-ref-sref${number}" title="View in article">${number}.</a></div>
	<div>Synthetic author ${number}.</div><div><strong>Synthetic reference ${number}.</strong></div><div><em>Synthetic journal.</em> 2026.</div>
	</div><div class="external-links"><a href="https://example.org/source-${number}">Source ${number}</a></div></div></div></div>`;
const html = `<!doctype html><html><head><title>Synthetic Cell citations</title></head><body><article>
	<h1>Synthetic Cell citations</h1><h2>Introduction</h2><div role="paragraph" id="intro">First finding.${citation(1)}<sup>,</sup>${citation(2, 'bib3')}
	Second finding.${citation(1, 'bib1', '-2', true)} End of paragraph.</div><p>${paragraph}</p>
	<h2>Results</h2><p>${paragraph}</p><figure><img src="/figure.png" alt="Synthetic figure"><figcaption>Figure 1. Synthetic legend.</figcaption></figure>
	<section id="references"><h2>References</h2><div role="doc-bibliography"><div class="bibliolist">${reference(1)}${reference(2, 'bib3')}</div></div></section>
	</article></body></html>`;
const template: Template = { id: 'test', name: 'Test', behavior: 'create', noteNameFormat: '{{title}}', path: '', noteContentFormat: '{{content}}', properties: [] };
const makeDocument = (input = html) => new DOMParser().parseFromString(input, 'text/html');

describe('publication date in the clipping template', () => {
	const source = 'https://journals.plos.org/example/article?id=synthetic';
	test.each([
		['<meta name="citation_date" content="2013年10月24日">', '', '2013-10-24'],
		['<meta name="citation_date" content="2013/02/30">', 'Published: October 24, 2013', '2013-10-24'],
		['<meta name="citation_publication_date" content="2013/10/24">', 'Published: October 25, 2013', '2013-10-24'],
		['<meta property="article:published_time" content="2011-01-02"><meta name="citation_date" content="2013年10月24日">', '', '2011-01-02'],
		['<meta name="citation_date" content="2013年2月29日">', 'Accepted: October 24, 2013', ''],
	])('propagates the article date from %s / %s', async (tags, label, expected) => {
		const html = `<html><head><title>Study</title>${tags}</head><body><ul><li id="artPubDate">${label}</li></ul>
			<article><h1>Study</h1><p>${paragraph}</p></article></body></html>`;
		const doc = makeDocument(html);
		Object.defineProperty(doc, 'URL', { value: source });
		const before = doc.documentElement.outerHTML;
		expect(parseForClip(doc).published).toBe(expected);
		expect(doc.documentElement.outerHTML).toBe(before);
		const result = await clip({ html, url: source, documentParser: new DOMParser(), template: {
			...template, properties: [{ name: 'published', value: '{{published}}', type: 'date' }],
		} });
		expect(result.fullContent.split('\n')).toContain(expected ? `published: ${expected}` : 'published:');
	});
});

describe('PLOS numbered references', () => {
	const source = 'https://journals.plos.org/example/article?id=synthetic';
	const body = `<p>These simulated observations agree with the first published result
		<a class="ref-tip" href="#paper.A">[1]</a> and an independent replication
		<a class="ref-tip" href="#paper.B">[2]</a>. We also repeat the measurements from the first study
		<a class="ref-tip" href="#paper.A">[1]</a> under controlled conditions.</p>`;
	const references = `<h2>References</h2><ol class="references">
		<li id="ref1"><span class="order">1.</span><a class="link-target" id="paper.A"></a>River A (2020).
		<i>A synthetic study</i>. Journal 4: 17. <ul class="reflinks"><li><a href="#">View Article</a></li>
		<li><a href="https://example.org/lookup">Search</a></li></ul></li>
		<li id="ref2"><span class="order">2.</span><a class="link-target" id="paper.B"></a>Lake B.
		<p>A second study. <a href="https://example.org/doi">DOI</a></p><ul class="find-nolinks"></ul></li></ol>`;
	const page = `<html><head><title>Synthetic research</title></head><body><article><h1>Synthetic research</h1>
		${body}<p>${paragraph}</p>${references}</article></body></html>`;

	test('keeps rich bibliography text, working links and repeated inline citations in manual and API clips', async () => {
		const document = makeDocument(page), before = document.documentElement.outerHTML;
		Object.defineProperty(document, 'URL', { value: source });
		const manual = createMarkdownContent(parseForClip(document).content, source);
		const api = await clip({ html: page, url: source, template, documentParser: new DOMParser() });
		for (const md of [manual, api.content]) {
			expect(md.match(/\[\^\d+\](?!:)/g)).toEqual(['[^1]', '[^2]', '[^1]']);
			expect(md).toMatch(/^\[\^1\]: River A \(2020\)\. \*A synthetic study\*\. Journal 4: 17\. \[Search\]\(https:\/\/example.org\/lookup\)$/m);
			expect(md).toMatch(/^\[\^2\]: Lake B\. A second study\. \[DOI\]\(https:\/\/example.org\/doi\)$/m);
			expect(md).not.toContain('View Article');
		}
		expect(document.documentElement.outerHTML).toBe(before);
		const capture = { document, source, extractedMarkdown: manual, templateMarkdown: manual };
		const broken = manual.replace(/^\[\^1\]: .*$/m, '[^1]: 1. [Search](https://example.org/lookup)');
		const report = checkManualExport(capture, broken);
		expect(report.stages.extraction.references).toMatchObject({ status: 'passed', expected: 2, matched: 2 });
		expect(report.stages.output.references).toMatchObject({ status: 'failed', matched: 1, issues: [{ id: 'ref1' }] });
	});

	test('leaves other hosts and unrelated fragment links alone', () => {
		const doc = makeDocument(page.replace(body, body + '<a class="ref-tip" href="#unrelated">[3]</a>'));
		expect(prepareDocumentForExtraction(doc, 'https://example.org/article')).toBe(doc);
		expect(prepareDocumentForExtraction(doc, source).querySelector('a[href="#unrelated"]')?.className).toBe('ref-tip');
	});
});

function expectCleanCitations(markdown: string) {
	expect(markdown).toMatch(/First finding\.\[\^1\](?:<sup>,<\/sup>|,)\[\^2\] Second finding\.\[\^1\] End of paragraph\./);
	expect(markdown).not.toContain('Preview-only');
	expect(markdown).not.toContain('Close preview');
	expect(markdown.match(/Synthetic reference 1\./g)).toHaveLength(1);
	expect(markdown.match(/Synthetic reference 2\./g)).toHaveLength(1);
	expect(markdown.indexOf('Synthetic reference 1.')).toBeGreaterThan(markdown.indexOf('## References'));
	expect(markdown).toContain('Synthetic author 1.');
	expect(markdown).toContain('*Synthetic journal.* 2026.');
	expect(markdown).toContain('Figure 1. Synthetic legend.');
	for (const number of [1, 2]) {
		const definition = markdown.split('\n').find(line => line.startsWith(`[^${number}]: `));
		expect(definition).toContain(`Synthetic author ${number}.`);
		expect(definition).toContain(`**Synthetic reference ${number}.**`);
		expect(definition).toContain('*Synthetic journal.* 2026.');
		expect(definition).toContain(`[Source ${number}](https://example.org/source-${number})`);
		expect(definition).not.toContain('View in article');
	}
}

describe('Cell inline citation previews', () => {
	test('preserves author-year labels and separators, removing only bound previews through manual/API extraction', async () => {
		const source = makeDocument(cellAuthorYearHtml), before = source.documentElement.outerHTML;
		Object.defineProperty(source, 'URL', { value: cellAuthorYearUrl });
		const manual = createMarkdownContent(parseForClip(source).content, cellAuthorYearUrl);
		const result = await clip({ html: cellAuthorYearHtml, url: cellAuthorYearUrl, template, documentParser: new DOMParser() });
		for (const markdown of [manual, result.content]) {
			expect(markdown).toMatch(/Finding \(Núñez et al\., 2024\s*\[\^1\]; Chen \(2025\)\s*\[\^2\]\)/);
			expect(markdown).toContain('Núñez et al. \\[2024\\]');
			expect(markdown).toMatch(/year 2025\s*\[\^2\]/);
			expect(markdown).not.toMatch(/Preview-only|Hidden reference preview/);
			for (const number of [1, 2]) expect(markdown.match(new RegExp(`Synthetic study ${number}\\.`, 'g'))).toHaveLength(1);
			expect(markdown).toContain('href="#fn:2"');
		}
		expect(source.documentElement.outerHTML).toBe(before);
		const prepared = prepareDocumentForExtraction(source, cellAuthorYearUrl);
		expect(prepareDocumentForExtraction(prepared, cellAuthorYearUrl)).toBe(prepared);
	});
	test('removes only linked previews in a copy, preserving markers, separators and the bibliography', () => {
		const source = makeDocument();
		const before = source.documentElement.outerHTML;
		const prepared = prepareDocumentForExtraction(source, url);
		expect(source.documentElement.outerHTML).toBe(before);
		expect(prepared.querySelectorAll('.reference-citations, #intro .dropBlock__holder')).toHaveLength(0);
		expect(prepared.querySelector('#intro')?.textContent?.replace(/\s+/g, ' ')).toBe('First finding.1,2 Second finding.1 End of paragraph.');
		expect(Array.from(prepared.querySelectorAll('#intro a')).map(a => a.getAttribute('href'))).toEqual(['#bib1', '#bib3', '#bib1']);
		expect(prepared.querySelector('#bib1 p')?.textContent).toContain('Synthetic author 1.');
		expect(prepared.querySelector('#bib1 .label')).toBeNull();
		expect(prepareDocumentForExtraction(prepared, url)).toBe(prepared);
	});
	test('leaves other hosts, unmatched popovers, and ordinary citation content alone', () => {
		const source = makeDocument();
		for (const other of ['https://example.com', 'https://cell.com.example.com', 'invalid']) {
			expect(prepareDocumentForExtraction(source, other)).toBe(source);
		}
		for (const invalid of [citation(1).replace('data-xml-rid="bib1"', 'data-xml-rid="fig1"'),
			citation(1).replace('id="sref1"', 'id="unrelated"'), citation(1).replace('<sup>1</sup>', '<sup>x</sup>')]) {
			const source = makeDocument(`<article>${invalid}<div class="dropBlock__holder"><div class="citation-content">Ordinary scientific content.</div></div></article>`);
			expect(prepareDocumentForExtraction(source, url).body.innerHTML).toBe(source.body.innerHTML);
		}
	});
	test('retains citation numbers when an exported excerpt has no bibliography', () => {
		const source = makeDocument(html.replace(/<section id="references">[\s\S]*?<\/section>/, ''));
		const prepared = prepareDocumentForExtraction(source, url);
		const result = createMarkdownContent(new Defuddle(prepared, { url }).parse().content, url);
		expect(result).not.toContain('Preview-only');
		expect(result).toContain('First finding.');
		expect(result).toContain('Second finding.');
		expect(result).toMatch(/1.*2.*Second finding.*1/);
	});
	test('keeps paragraphs intact through synchronous and async extension extraction', async () => {
		expect(createMarkdownContent(new Defuddle(makeDocument(), { url }).parse().content, url)).toContain('Preview-only');
		for (const asyncMode of [false, true]) {
			const parser = new Defuddle(prepareDocumentForExtraction(makeDocument(), url), { url });
			const result = asyncMode ? await parser.parseAsync() : parser.parse();
			expectCleanCitations(createMarkdownContent(result.content, url));
		}
	});
	test('keeps paragraphs intact through manual Markdown saves and the API', async () => {
		const source = makeDocument();
		Object.defineProperty(source, 'URL', { value: url });
		expectCleanCitations(createMarkdownContent(parseForClip(source).content, url));
		expectCleanCitations((await clip({ html, url, template, documentParser: new DOMParser() })).content);
	});
});
