// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import Defuddle from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';
import { clip } from '../api';
import { parseForClip } from './clip-utils';
import { prepareDocumentForExtraction } from './publisher-figures';
import type { Template } from '../types/types';

const url = 'https://www.nature.com/articles/figure-fixture';
const paragraph = 'This scientific article describes cells, spatial domains and the experimental method. '.repeat(100);
const figure = `<figure><figcaption><b id="Fig1">Fig. 1: Model overview.</b></figcaption>
	<div class="c-article-section__figure-content"><picture><img src="/figure.png" alt="Fig. 1: Model overview." width="685" height="395"></picture>
	<div class="c-article-section__figure-description" id="figure-1-desc"><p><b>a</b>, Detailed panel description with <a href="https://example.com/source">source link</a>.</p>
	<p><b>b</b>, Repeated values <i>x</i> and <i>x</i> are meaningful. <math data-latex="x_i + y_i">x_i + y_i</math></p></div></div></figure>`;
const html = `<!doctype html><html><head><title>Figure fixture</title></head><body><article><h1>Figure fixture</h1><h2>Results</h2><p>${paragraph}</p>${figure}<p>After figure marker.</p><h2>Methods</h2><p>${paragraph}</p></article></body></html>`;
const template: Template = { id: 'test', name: 'Test', behavior: 'create', noteNameFormat: '{{title}}', path: '', noteContentFormat: '{{content}}', properties: [] };
const makeDocument = () => new DOMParser().parseFromString(html, 'text/html');

function expectLegend(markdown: string) {
	expect(markdown).toContain('**a**, Detailed panel description');
	expect(markdown).toContain('[source link](https://example.com/source)');
	expect(markdown).toContain('**b**, Repeated values *x* and *x*');
	expect(markdown).toContain('$x_i + y_i$');
	expect(markdown.split('Detailed panel description')).toHaveLength(2);
	expect(markdown.indexOf('Fig. 1: Model overview.')).toBeLessThan(markdown.indexOf('Detailed panel description'));
	expect(markdown.indexOf('Detailed panel description')).toBeLessThan(markdown.indexOf('After figure marker.'));
}

describe('Nature full figure legends', () => {
	test('prepares a copy without changing the live DOM, and is idempotent', () => {
		const source = makeDocument();
		const before = source.documentElement.outerHTML;
		const prepared = prepareDocumentForExtraction(source, url);
		expect(source.documentElement.outerHTML).toBe(before);
		expect(prepared).not.toBe(source);
		expect(prepared.querySelector('figure')?.nextElementSibling?.id).toBe('figure-1-desc');
		expect(prepared.querySelector('#figure-1-desc a')?.getAttribute('href')).toBe('https://example.com/source');
		expect(prepareDocumentForExtraction(prepared, url)).toBe(prepared);
	});
	test('does not change unrelated sites, similar hostnames or arbitrary descriptions', () => {
		const source = makeDocument();
		for (const other of ['https://example.com', 'https://nature.com.example.com', 'invalid']) {
			expect(prepareDocumentForExtraction(source, other)).toBe(source);
		}
		const unrelated = new DOMParser().parseFromString('<figure><img src="/x.png"><div class="description">Unrelated</div></figure>', 'text/html');
		expect(prepareDocumentForExtraction(unrelated, url)).toBe(unrelated);
	});
	test('retains multiple figures in order and ignores sidebar title-only copies', () => {
		const source = new DOMParser().parseFromString(html.replace('</article>', `${figure.replace(/Fig1/g, 'Fig2').replace(/figure-1-desc/g, 'figure-2-desc')}<aside><figure><figcaption>Sidebar</figcaption><img src="/sidebar.png"></figure></aside></article>`), 'text/html');
		const result = prepareDocumentForExtraction(source, url);
		expect(Array.from(result.querySelectorAll('[id^="figure-"]')).map(node => node.previousElementSibling?.querySelector('b')?.id)).toEqual(['Fig1', 'Fig2']);
		expect(result.querySelector('aside')?.textContent).toBe('Sidebar');
	});
	test('preserves legends through the real synchronous and async extraction used by manual clipping', async () => {
		for (const asyncMode of [false, true]) {
			const source = makeDocument();
			const parser = new Defuddle(prepareDocumentForExtraction(source, url), { url });
			const result = asyncMode ? await parser.parseAsync() : parser.parse();
			expectLegend(createMarkdownContent(result.content, url));
		}
	});
	test('preserves legends through the extension save-Markdown path', () => {
		const source = makeDocument();
		Object.defineProperty(source, 'URL', { value: url });
		expectLegend(createMarkdownContent(parseForClip(source).content, url));
	});
	test('preserves legends through the API with a browser document parser', async () => {
		const result = await clip({ html, url, template, documentParser: new DOMParser() });
		expectLegend(result.content);
	});
	test('preserves comma-separated citation groups through manual and API extraction without changing the source', async () => {
		const citations = '<sup><a href="#ref-CR1">1</a>,<a href="#ref-CR2">2</a></sup>';
		const fixture = html.replace('Detailed panel description', `Detailed panel description ${citations}`)
			.replace('</article>', '<h2>References</h2><ol><li id="ref-CR1">First synthetic source.</li><li id="ref-CR2">Second synthetic source.</li></ol></article>');
		const source = new DOMParser().parseFromString(fixture, 'text/html');
		const before = source.documentElement.outerHTML;
		const prepared = prepareDocumentForExtraction(source, url);
		expect(prepared.querySelector('#figure-1-desc')?.textContent).toContain('1,2');
		expect(prepared.querySelectorAll('#figure-1-desc sup')).toHaveLength(2);
		expect(source.documentElement.outerHTML).toBe(before);
		for (const asyncMode of [false, true]) {
			const parser = new Defuddle(prepareDocumentForExtraction(source, url), { url });
			const result = asyncMode ? await parser.parseAsync() : parser.parse();
			expect(createMarkdownContent(result.content, url)).toContain('[^1],[^2]');
		}
		const result = await clip({ html: fixture, url, template, documentParser: new DOMParser() });
		expect(result.content).toContain('[^1],[^2]');
	});
	test('does not rewrite scientific superscripts, non-citation links or references to another article', () => {
		for (const sup of ['<sup>x<a href="#ref-CR1">1</a>,<a href="#ref-CR2">2</a></sup>',
			'<sup><a href="#ref-CR1">label</a>,<a href="#ref-CR2">2</a></sup>',
			'<sup><a href="https://example.com/#ref-CR1">1</a>,<a href="#ref-CR2">2</a></sup>']) {
			const source = new DOMParser().parseFromString(html.replace('Detailed panel description', sup), 'text/html');
			expect(prepareDocumentForExtraction(source, url).querySelector('#figure-1-desc sup')?.outerHTML).toBe(sup);
		}
	});
});

describe('Publisher collapsed and linked figures', () => {
	const cell = 'https://www.cell.com/cell/fulltext/synthetic';
	const caption = `<figure id="fig1" class="graphic"><img src="/large.jpg"><figcaption class="figure__caption__body">
		<div class="figure__title">Figure 1 Synthetic panels</div><div class="accordion"><button aria-expanded="false">Show full caption</button>
		<div class="accordion__content" style="display: none" aria-hidden="true"><div class="figure__caption__text__content">
		<div role="paragraph">(A) Synthetic workflow with <i>x</i>.</div><div role="paragraph">(B) Independent observation. See <a href="https://example.org/data">source data</a>.</div>
		<div role="paragraph">(J) Immune-related features across synthetic groups.</div>
		</div></div></div></figcaption></figure>`;
	const extended = `<div class="c-article-supplementary__item" id="Fig6"><h3><a href="/articles/figure-fixture/figures/6"
		data-supp-info-image="//media.springernature.com/lw685/springer-static/esm/art%3Asynthetic/MediaObjects/figure6.jpg">Extended Data Fig. 1 Synthetic extension.</a></h3>
		<div class="c-article-supplementary__description"><p><b>a</b>, Extended observation.</p></div></div>`;
	const sourceWith = (content: string) => html.replace(figure, content);
	test('preserves collapsed or expanded Cell legends without clicking or mutating the source', async () => {
		for (const content of [caption, caption.replace('display: none', 'display: block').replace('aria-hidden="true"', 'aria-hidden="false"')]) {
			const input = sourceWith(content);
			const source = new DOMParser().parseFromString(input, 'text/html');
			const before = source.documentElement.outerHTML;
			const prepared = prepareDocumentForExtraction(source, cell);
			expect(source.documentElement.outerHTML).toBe(before);
			expect(prepareDocumentForExtraction(prepared, cell)).toBe(prepared);
			for (const asyncMode of [false, true]) {
				const parser = new Defuddle(prepareDocumentForExtraction(source, cell), { url: cell });
				const parsed = asyncMode ? await parser.parseAsync() : parser.parse();
				const result = createMarkdownContent(parsed.content, cell);
				expect(result.match(/\(A\) Synthetic workflow/g)).toHaveLength(1);
				expect(result).toContain('(B) Independent observation. See [source data](https://example.org/data).');
				expect(result).not.toContain('Show full caption');
				expect(result).toContain('(J) Immune-related features across synthetic groups.');
			}
			expect((await clip({ html: input, url: cell, template, documentParser: new DOMParser() })).content).toContain('(A) Synthetic workflow');
		}
	});
	test('embeds Nature linked extended figures from their declared image URLs in all conversion routes', async () => {
		const input = sourceWith(extended);
		const source = new DOMParser().parseFromString(input, 'text/html');
		const before = source.documentElement.outerHTML;
		const prepared = prepareDocumentForExtraction(source, url);
		expect(source.documentElement.outerHTML).toBe(before);
		expect(prepareDocumentForExtraction(prepared, url)).toBe(prepared);
		Object.defineProperty(source, 'URL', { value: url });
		const outputs = [createMarkdownContent(parseForClip(source).content, url),
			(await clip({ html: input, url, template, documentParser: new DOMParser() })).content];
		for (const asyncMode of [false, true]) {
			const parser = new Defuddle(prepareDocumentForExtraction(source, url), { url });
			outputs.push(createMarkdownContent((asyncMode ? await parser.parseAsync() : parser.parse()).content, url));
		}
		for (const result of outputs) {
			expect(result).toContain('![Extended Data Fig. 1 Synthetic extension.](https://media.springernature.com/lw685/springer-static/esm/art%3Asynthetic/MediaObjects/figure6.jpg)');
			expect(result.match(/\*\*a\*\*, Extended observation\./g)).toHaveLength(1);
		}
	});
	test('does not duplicate already loaded images, invent URLs, or expand unrelated hidden content', () => {
		const input = sourceWith(extended.replace('</h3>', '</h3><img src="https://media.springernature.com/loaded.jpg">'));
		const source = new DOMParser().parseFromString(input, 'text/html');
		expect(prepareDocumentForExtraction(source, url).querySelectorAll('img')).toHaveLength(1);
		for (const invalid of [extended.replace('media.springernature.com', '127.0.0.1'), extended.replace('Extended Data Fig.', 'Supplementary Table'),
			extended.replace('/articles/figure-fixture/figures/6', '/articles/other/figures/6'), extended.replace('data-supp-info-image', 'data-unrelated')]) {
			const source = new DOMParser().parseFromString(sourceWith(invalid), 'text/html');
			expect(prepareDocumentForExtraction(source, url).querySelector('img')).toBeNull();
		}
		const unrelated = new DOMParser().parseFromString('<article><div style="display:none">Unrelated hidden UI.</div></article>', 'text/html');
		expect(prepareDocumentForExtraction(unrelated, cell)).toBe(unrelated);
		expect(prepareDocumentForExtraction(new DOMParser().parseFromString(sourceWith(extended), 'text/html'), 'https://nature.com.example.org').querySelector('img')).toBeNull();
	});
});
