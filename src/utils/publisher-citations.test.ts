// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import Defuddle from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';
import { clip } from '../api';
import { parseForClip } from './clip-utils';
import { prepareDocumentForExtraction } from './publisher-figures';
import type { Template } from '../types/types';

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
