// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import Defuddle from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';
import { clip } from '../api';
import { parseForClip } from './clip-utils';
import { prepareDocumentForExtraction } from './publisher-figures';
import type { Template } from '../types/types';
import { pmcHtml, pmcUrl } from '../../scripts/fixtures/pmc.mjs';
import { natureFiguresHtml, natureFiguresUrl } from '../../scripts/fixtures/nature-figures.mjs';
import { marked } from 'marked';

const url = 'https://www.nature.com/articles/figure-fixture';
const paragraph = 'This scientific article describes cells, spatial domains and the experimental method. '.repeat(100);
const figure = `<figure><figcaption><b id="Fig1">Fig. 1: Model overview.</b></figcaption>
	<div class="c-article-section__figure-content"><picture><img src="/figure.png" alt="Fig. 1: Model overview." width="685" height="395"></picture>
	<div class="c-article-section__figure-description" id="figure-1-desc"><p><b>a</b>, Detailed panel description with <a href="https://example.com/source">source link</a>.</p>
	<p><b>b</b>, Repeated values <i>x</i> and <i>x</i> are meaningful. <math data-latex="x_i + y_i">x_i + y_i</math></p></div></div></figure>`;
const html = `<!doctype html><html><head><title>Figure fixture</title></head><body><article><h1>Figure fixture</h1><h2>Results</h2><p>${paragraph}</p>${figure}<p>After figure marker.</p><h2>Methods</h2><p>${paragraph}</p></article></body></html>`;
const template: Template = { id: 'test', name: 'Test', behavior: 'create', noteNameFormat: '{{title}}', path: '', noteContentFormat: '{{content}}', properties: [] };
const makeDocument = () => new DOMParser().parseFromString(html, 'text/html');

describe('PMC header and figure preservation', () => {
	test('only deduplicates mapped header names on PMC and preserves source, notes and prose', () => {
		const source = new DOMParser().parseFromString(pmcHtml, 'text/html');
		const before = source.documentElement.outerHTML;
		const prepared = prepareDocumentForExtraction(source, pmcUrl);
		expect(source.documentElement.outerHTML).toBe(before);
		expect(prepared.querySelector('.cg')).toBeNull();
		expect(prepared.querySelectorAll('meta[name="citation_author"]')).toHaveLength(2);
		expect(prepared.body.textContent).toContain('Author contributions must remain.');
		expect(prepared.body.textContent).toContain('Open access attribution must remain.');
		expect(prepared.body.textContent).toContain('Ada Example is also mentioned');
		expect(prepared.body.textContent).toContain('Ada Example. Synthetic reference.');
		expect(prepareDocumentForExtraction(prepared, pmcUrl)).toBe(prepared);
		for (const host of ['https://example.org/', 'https://pmc.ncbi.nlm.nih.gov.example.org/']) {
			expect(prepareDocumentForExtraction(source, host)).toBe(source);
		}
		const missing = new DOMParser().parseFromString(pmcHtml.replace('name="citation_author" content="Ben Sample"', 'name="other" content="Ben Sample"'), 'text/html');
		expect(prepareDocumentForExtraction(missing, pmcUrl).querySelector('.cg')).not.toBeNull();
		const unknown = new DOMParser().parseFromString(pmcHtml.replace('<sup>2</sup></div>', '<sup>2</sup>, Unmapped contributor</div>'), 'text/html');
		expect(prepareDocumentForExtraction(unknown, pmcUrl).querySelector('.cg')).not.toBeNull();
	});
	test('retains figure titles and rich panels through sync, async, manual and API conversion', async () => {
		const source = new DOMParser().parseFromString(pmcHtml, 'text/html');
		Object.defineProperty(source, 'URL', { value: pmcUrl });
		const manual = parseForClip(source);
		expect(manual.author).toContain('Ada Example');
		expect(manual.author).toContain('Ben Sample');
		const output = [createMarkdownContent(manual.content, pmcUrl),
			(await clip({ html: pmcHtml, url: pmcUrl, template, documentParser: new DOMParser() })).content];
		for (const asyncMode of [false, true]) {
			const parser = new Defuddle(prepareDocumentForExtraction(source, pmcUrl), { url: pmcUrl });
			output.push(createMarkdownContent((asyncMode ? await parser.parseAsync() : parser.parse()).content, pmcUrl));
		}
		for (const md of output) {
			expect(md.match(/Figure 1\. Synthetic experimental workflow\./g)).toHaveLength(1);
			expect(md.indexOf('Figure 1. Synthetic experimental workflow.')).toBeLessThan(md.indexOf('![Figure 1.]'));
			expect(md.indexOf('(A) Synthetic workflow.')).toBeGreaterThan(md.indexOf('![Figure 1.]'));
			expect(md.indexOf('(B) Measured')).toBeLessThan(md.indexOf('After figure marker.'));
			expect(md).toMatch(/\[Figure S1\]\((?:https:\/\/pmc\.ncbi\.nlm\.nih\.gov\/articles\/PMC1234567\/)?#SD1\)/);
			expect(md).not.toContain('/author/');
			expect(md).not.toContain('Find articles by');
			expect(md).not.toContain('Open in a new tab');
			expect(md).toContain('Ada Example is also mentioned');
		}
	});
});

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
	test('keeps caption punctuation outside emphasis while retaining labels, values and an immutable source', async () => {
		const source = new DOMParser().parseFromString(natureFiguresHtml, 'text/html');
		const before = source.documentElement.outerHTML;
		const prepared = prepareDocumentForExtraction(source, natureFiguresUrl);
		expect(prepared.querySelector('#figure-6-desc')?.textContent).toBe(source.querySelector('#figure-6-desc')?.textContent);
		expect(source.documentElement.outerHTML).toBe(before);
		expect(prepareDocumentForExtraction(prepared, natureFiguresUrl)).toBe(prepared);
		Object.defineProperty(source, 'URL', { value: natureFiguresUrl });
		const outputs = [createMarkdownContent(parseForClip(source).content, natureFiguresUrl),
			(await clip({ html: natureFiguresHtml, url: natureFiguresUrl, template, documentParser: new DOMParser() })).content];
		for (const md of outputs) {
			const rendered = new DOMParser().parseFromString(marked.parse(md) as string, 'text/html');
			expect(rendered.body.textContent).toContain('BETA n = 7, GAMMA n = 9');
			expect(rendered.body.textContent).toContain('x = 3; y = 4');
			expect(rendered.body.textContent).not.toContain('*');
			expect(Array.from(rendered.querySelectorAll('em')).map(el => el.textContent)).toEqual(expect.arrayContaining(['ALPHA', 'BETA', 'GAMMA', 'DELTA', 'n', 'P', 'x', 'y']));
		}
	});
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

describe('unified MathJax, MathML and Frontiers preprocessing', () => {
	test('converts .mathjax-tex elements outside code and normalizes MathML \\hdots and nested tables idempotently', () => {
		const input = `<!doctype html><html><head><title>Math test</title></head><body><article>
			<p>Inline <span class="mathjax-tex">\\(x_i + 1\\)</span> and block <div class="mathjax-tex">\\[a^2 + b^2\\]</div></p>
			<pre><span class="mathjax-tex">\\(ignored\\)</span></pre>
			<math display="inline"><mi>x</mi><mo>⋯</mo><mi>y</mi></math>
			<math display="block"><mtable><mtr><mtd><mtable><mtr><mtd><mn>1</mn></mtd></mtr></mtable></mtd></mtr></mtable></math>
		</article></body></html>`;
		const source = new DOMParser().parseFromString(input, 'text/html');
		const before = source.documentElement.outerHTML;
		const prepared = prepareDocumentForExtraction(source, 'https://example.org/math');
		expect(source.documentElement.outerHTML).toBe(before);
		expect(prepared.querySelectorAll('.mathjax-tex math[data-latex]')).toHaveLength(2);
		expect(prepared.querySelector('pre .mathjax-tex math')).toBeNull();
		const mathNodes = Array.from(prepared.querySelectorAll('article > math[data-latex]'));
		expect(mathNodes).toHaveLength(2);
		expect(mathNodes[0].getAttribute('data-latex')).toContain('\\cdots');
		expect(mathNodes[0].getAttribute('data-latex')).not.toContain('\\hdots');
		expect(mathNodes[1].getAttribute('data-latex')).toContain('\\begin{matrix}');
		expect(prepareDocumentForExtraction(prepared, 'https://example.org/math')).toBe(prepared);
	});

	test('unwraps Frontiers lightbox figure buttons and resolves ArticleReference links idempotently', () => {
		const frontiersUrl = 'https://www.frontiersin.org/journals/test/articles/10.3389/test.2024.0001/full';
		const input = `<!doctype html><html><head><title>Frontiers</title></head><body><article>
			<p>See <a class="ArticleReference" href="#B1">[1]</a> and <code><a class="ArticleReference" href="#B2">[2]</a></code>.</p>
			<div class="ArticleFigure"><button class="ArticleFigure__figureButton"><figure><img src="https://example.org/fig.png" alt="Fig 1"><figcaption>Figure caption preserved.</figcaption></figure></button></div>
		</article></body></html>`;
		const source = new DOMParser().parseFromString(input, 'text/html');
		const before = source.documentElement.outerHTML;
		const prepared = prepareDocumentForExtraction(source, frontiersUrl);
		expect(source.documentElement.outerHTML).toBe(before);
		expect(prepared.querySelector('.ArticleFigure button.ArticleFigure__figureButton')).toBeNull();
		expect(prepared.querySelector('.ArticleFigure figure figcaption')?.textContent).toBe('Figure caption preserved.');
		const resolvedLink = prepared.querySelector('p > a');
		expect(resolvedLink?.getAttribute('href')).toBe(`${frontiersUrl}#B1`);
		expect(resolvedLink?.classList.contains('ArticleReference')).toBe(false);
		expect(prepared.querySelector('code a.ArticleReference')?.getAttribute('href')).toBe('#B2');
		expect(prepareDocumentForExtraction(prepared, frontiersUrl)).toBe(prepared);
	});
});

describe('SpringerLink and BMC preservation', () => {
	const springerUrl = 'https://link.springer.com/article/10.1038/s44318-024-00123-3';
	const bmcUrl = 'https://bmcbiomedeng.biomedcentral.com/articles/10.1186/s42490-021-00056-6';
	const springerHtml = `<!doctype html><html><head><title>Polarity paper</title></head><body><article id="main">
		<div class="c-article-header">
			<ul class="c-article-author-list"><li>Author One<sup><a href="#Aff1">1</a>,<a href="#Aff2">2</a></sup></li><li>Author Two<sup><a href="#Aff1">1</a></sup></li></ul>
		</div>
		<div id="main-content"><main><div class="c-article-body">
			<section data-title="Abstract"><h2>Abstract</h2><p>${paragraph}</p></section>
			<section data-title="Synopsis"><h2>Synopsis</h2>
				<div class="c-article-section__figure"><figure><img src="//media.springernature.com/lw685/springer-static/image/art%3A10.1038%2Fs44318-024-00123-3/MediaObjects/44318_2024_123_Figa_HTML.png" alt=""></figure></div>
				<p>Synopsis summary of polarity mechanism.</p>
			</section>
			<section class="c-article-recommendations"><h2>Similar content being viewed by others</h2>
				<article><img src="https://media.springernature.com/w215h120/springer-static/image/art%3A10.1007%2Frecommended/MediaObjects/rec.png" alt="Recommended"><h3>Unrelated paper</h3></article>
			</section>
			<div class="main-content">
				<section data-title="Results"><h2>Results</h2><p>${paragraph} As shown earlier (Goehring, <a data-test="citation-ref" href="/article/10.1038/s44318-024-00123-3#ref-CR1">2014</a>) and Equation <a data-track-action="equation anchor" href="#Equ1">1</a>.</p>
				<div id="Equ1" class="c-article-equation"><span class="mathjax-tex">$$c_{\\rm tot} = c_{\\rm c}$$</span></div>
				<div class="c-article-table"><figure><figcaption><b>Table 1 Summary table</b></figcaption><div class="u-hide-print"><a data-test="table-link" href="/article/10.1038/s44318-024-00123-3/tables/1">Full size table</a></div></figure></div>
				<div class="c-article-section__figure"><figure>
					<figcaption><b id="Fig1" class="c-article-section__figure-caption">Figure 1: Cooperative membrane binding.</b></figcaption>
					<div class="c-article-section__figure-content"><picture><img src="//media.springernature.com/lw685/springer-static/image/art%3A10.1038%2Fs44318-024-00123-3/MediaObjects/44318_2024_123_Fig1_HTML.png" alt="Figure 1: Cooperative membrane binding."></picture>
					<div class="c-article-section__figure-link"><a class="c-article__pill-button" data-track-action="view figure" href="/article/10.1038/s44318-024-00123-3/figures/1"><span>Full size image</span></a></div>
					<div class="c-article-section__figure-description"><p>(<b>A</b>) First panel observation.</p></div></div>
				</figure></div>
				<div class="c-article-section__figure"><figure>
					<figcaption><b id="FigEV1" class="c-article-section__figure-caption">Figure EV1: Extended dataset.</b></figcaption>
					<div class="c-article-section__figure-content"><picture><img src="//media.springernature.com/lw685/springer-static/image/art%3A10.1038%2Fs44318-024-00123-3/MediaObjects/44318_2024_123_Fig2_HTML.jpg" alt="Figure EV1: Extended dataset."></picture>
					<div class="c-article-section__figure-link"><a class="c-article__pill-button" data-track-action="view figure" href="/article/10.1038/s44318-024-00123-3/figures/2"><span>Full size image</span></a></div>
					<div class="c-article-section__figure-description"><p>(<b>A</b>) Extended panel observation.</p></div></div>
				</figure></div>
				<p>Grouped markers<b>(</b>see Fig. 1<b>; </b><b>).</b> And italic suffix<i>.</i> and <code><i>.</i></code></p>
				</section>
			</div>
			<section data-title="References"><h2>References</h2><ul class="c-article-references"><li><p id="ref-CR1">Goehring NW (2014) PAR polarity.</p></li></ul></section>
			<section data-title="Additional files"><h2>Additional files</h2>
				<div class="c-article-supplementary__item" id="MOESM1"><h3><a data-test="supp-info-link" href="https://static-content.springer.com/esm/art%3A10.1186%2Fs13059-019-1713-4/MediaObjects/13059_2019_1713_MOESM1_ESM.pdf" data-supp-info-image="">Additional file 1: (download PDF <svg></svg>)</a></h3><div class="c-article-supplementary__description"><p><b>Figure S1.</b> Benchmarking.</p></div></div>
			</section>
			<section data-title="Supplementary Information"><h2>Supplementary Information</h2>
				<div class="c-article-supplementary__item" id="MOESM2"><h3><a data-test="supp-info-link" href="https://static-content.springer.com/esm/art%3A10.1186%2Fs12859-024-05935-y/MediaObjects/12859_2024_5935_MOESM1_ESM.docx" data-supp-info-image="">Supplementary Material 1 (download DOCX <svg></svg>)</a></h3></div>
			</section>
		</div></main></div>
	</article></body></html>`;

	test('preserves SpringerLink body, Synopsis, captions and formulas while stripping Full size image and recommendations', async () => {
		for (const targetUrl of [springerUrl, bmcUrl]) {
			const source = new DOMParser().parseFromString(springerHtml, 'text/html');
			const before = source.documentElement.outerHTML;
			const prepared = prepareDocumentForExtraction(source, targetUrl);
			expect(source.documentElement.outerHTML).toBe(before);
			expect(prepareDocumentForExtraction(prepared, targetUrl)).toBe(prepared);

			const outputs = [
				(await clip({ html: springerHtml, url: targetUrl, template, documentParser: new DOMParser() })).content,
			];
			for (const asyncMode of [false, true]) {
				const parser = new Defuddle(prepareDocumentForExtraction(source, targetUrl), { url: targetUrl });
				outputs.push(createMarkdownContent((asyncMode ? await parser.parseAsync() : parser.parse()).content, targetUrl));
			}
			const origin = new URL(targetUrl).origin;
			for (const md of outputs) {
				expect(md).toContain('## Results');
				expect(md).toContain('## Synopsis');
				expect(md).toMatch(/2014\s*\[\^1\]/);
				expect(md).toContain('[^1]: Goehring NW (2014) PAR polarity.');
				expect(md).not.toMatch(/\[\^1\]:[\s\S]*c_\{\\rm tot\}/);
				expect(md).toContain(`[Full size table](${origin}/article/10.1038/s44318-024-00123-3/tables/1)`);
				expect(md).toContain('44318_2024_123_Figa_HTML.png');
				expect(md).toContain('44318_2024_123_Fig1_HTML.png');
				expect(md).toContain('44318_2024_123_Fig2_HTML.jpg');
				expect(md).toContain('(**A**) First panel observation.');
				expect(md).toContain('(**A**) Extended panel observation.');
				expect(md).toContain('**Additional file 1:** ([download PDF](https://static-content.springer.com/esm/art%3A10.1186%2Fs13059-019-1713-4/MediaObjects/13059_2019_1713_MOESM1_ESM.pdf))');
				expect(md).toContain('**Figure S1.** Benchmarking.');
				expect(md).toContain('## Supplementary Information');
				expect(md).toContain('**Supplementary Material 1** ([download DOCX](https://static-content.springer.com/esm/art%3A10.1186%2Fs12859-024-05935-y/MediaObjects/12859_2024_5935_MOESM1_ESM.docx))');
				expect(md).not.toContain('**(**');
				expect(md).not.toContain('**;**');
				expect(md).not.toContain('**).**');
				expect(md).toContain('And italic suffix. and `*.*`');
				expect(md).not.toContain('Full size image');
				expect(md).not.toContain('Similar content being viewed by others');
				expect(md).not.toContain('rec.png');
			}
		}
		const spoofed = new DOMParser().parseFromString(springerHtml.replace(/<div id="Equ1"[\s\S]*?<\/div>/, ''), 'text/html');
		expect(prepareDocumentForExtraction(spoofed, 'https://link.springer.com.example.org/article')).toBe(spoofed);
	});
});
