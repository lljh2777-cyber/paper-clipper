import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFigureCaptions } from './paper-captions.mjs';

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
