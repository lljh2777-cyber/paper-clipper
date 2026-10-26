import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { checkFigureCaptions } from './paper-captions.mjs';
import { pmcHtml, pmcUrl } from './fixtures/pmc.mjs';

test('PMC CLI preserves figure titles, rich panels and metadata while removing only the duplicated byline', () => {
	const output = execFileSync(process.execPath, ['dist/cli.cjs', pmcUrl, '--html', '-', '-t', 'src/utils/fixtures/templates/minimal.json'], { input: pmcHtml, encoding: 'utf8' });
	assert.equal(output.split('Figure 1. Synthetic experimental workflow.').length, 2);
	assert.ok(output.indexOf('Figure 1. Synthetic experimental workflow.') < output.indexOf('![Figure 1.]'));
	assert.match(output, /\[Figure S1\]\((?:https:\/\/pmc\.ncbi\.nlm\.nih\.gov\/articles\/PMC1234567\/)?#SD1\)/);
	assert.doesNotMatch(output, /\/author\/|Find articles by|Open in a new tab/);
	assert.match(output, /Ada Example is also mentioned/);
});

const url = 'https://www.nature.com/articles/fixture';
const html = '<html><body><figure><figcaption>Fig. 1: Overview.</figcaption><img src="/figure.png"><div class="c-article-section__figure-description" id="figure-1-desc"><p><b>a</b>, Full legend with <a href="/data">data</a>.</p><p><b>b</b>, Second panel.</p></div></figure></body></html>';
const markdown = '![Figure](/figure.png)\n\nFig. 1: Overview.\n\n**a**, Full legend with [data](https://www.nature.com/data).\n\n**b**, Second panel.\n';

test('production caption check distinguishes verified coverage from unsupported publishers and absent structures', () => {
	for (const other of ['https://example.com/article', 'https://nature.com.example.com/article', 'https://www-nature-com.proxy.example/article']) {
		const result = checkFigureCaptions(html, '', other);
		assert.equal(result.status, 'not-applicable');
		assert.equal(result.reason, 'unsupported-publisher');
		assert.equal(result.matched, 0);
	}
	assert.equal(checkFigureCaptions('<html></html>', '', url).reason, 'no-supported-legends');
	const result = checkFigureCaptions(html, markdown.replace(/\n/g, '\r\n'), url);
	assert.equal(result.status, 'passed');
	assert.equal(result.expected, 1);
	assert.equal(result.matched, 1);
	assert.equal(result.figures[0].id, 'figure-1-desc');
	assert.equal(result.figures[0].paragraphs, 2);
	assert.equal(result.blocks, undefined);
});

test('production caption check fails missing, shortened, duplicated, relocated and link-stripped legends with figure diagnostics', () => {
	for (const bad of ['', markdown.replace('Full legend with ', ''), markdown + '\n**b**, Second panel.\n',
		markdown.replace('**a**,', 'Intervening body.\n\n**a**,'), markdown.replace('[data](https://www.nature.com/data)', 'data')]) {
		const result = checkFigureCaptions(html, bad, url);
		assert.equal(result.status, 'failed');
		assert.equal(result.failed, 1);
		assert.equal(result.matched, 0);
		assert.equal(result.figures[0].title, 'Fig. 1: Overview.');
		assert.ok(result.figures[0].errors.length);
	}
	assert.equal(checkFigureCaptions(html.replace(/<p>[\s\S]*<\/p>/, ''), markdown, url).status, 'failed');
});

test('Cell conversion and source checks retain collapsed panel text and complete citation definitions', () => {
	const cell = 'https://www.cell.com/cell/fulltext/synthetic';
	const prose = 'Synthetic tissue measurements were repeated across independent experimental groups. '.repeat(40);
	const input = `<html><head><title>Synthetic Cell article</title></head><body><article><h1>Synthetic Cell article</h1>
		<h2>Results</h2><p>${prose}<a href="#bib3"><sup>1</sup></a>, <a href="#bib4"><sup>2</sup></a></p><figure id="fig1" class="graphic"><img src="/figure.png">
		<figcaption><div class="figure__title">Figure 1 Synthetic panels.</div><div class="accordion"><button>Show full caption</button>
		<div style="display:none"><div class="figure__caption__text__content"><div role="paragraph">(A) Synthetic panel.</div>
		<div role="paragraph">(B) Immune-related features across groups. <a href="/data">Data</a>.</div></div></div></div></figcaption></figure>
		<h2>Methods</h2><p>${prose}</p><section id="references"><h2>References</h2><div role="doc-bibliography"><div class="bibliolist"><div class="biblioentry"><div class="citations" id="bib3">
		<div class="citation-content"><div class="label"><a href="#body-ref">1.</a></div><div>Author A.</div><div><b>Synthetic reference.</b></div>
		<div><i>Journal.</i> 2026; 1:2-3.</div></div><div class="external-links"><a href="https://example.org/ref">Source</a></div></div></div>
		<div class="biblioentry"><div class="citations" id="bib4"><div class="citation-content"><div class="label">2.</div>
		<div>Author B.</div><div><b>Another synthetic reference.</b></div><div>Journal. 2025.</div></div></div></div></div></div></section>
		</article></body></html>`;
	const output = execFileSync(process.execPath, ['dist/cli.cjs', cell, '--html', '-', '-t', 'src/utils/fixtures/templates/minimal.json'], { input, encoding: 'utf8' });
	const checked = checkFigureCaptions(input, output, cell);
	assert.equal(checked.status, 'passed');
	assert.equal(checked.publisher, 'cell');
	assert.equal(checked.figures[0].paragraphs, 2);
	assert.equal(checkFigureCaptions(input, output.replace('(A) Synthetic panel.', ''), cell).status, 'failed');
	assert.equal(checkFigureCaptions(input, output.replace('[Data](https://www.cell.com/data)', 'Data'), cell).status, 'failed');
	assert.equal(checkFigureCaptions(input, output + '\n\n(A) Synthetic panel.', cell).status, 'failed');
	const footnote = output.split('\n').find(line => line.startsWith('[^1]:'));
	assert.match(footnote, /Author A\..*\*\*Synthetic reference\.\*\*.*\*Journal\.\* 2026; 1:2-3\..*\[Source\]\(https:\/\/example\.org\/ref\)/);
	assert.doesNotMatch(footnote, /#body-ref/);
});
