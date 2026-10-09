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
