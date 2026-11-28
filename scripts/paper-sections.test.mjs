import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSourceSections, sourceSectionsVersion } from './paper-sections.mjs';
import { assessMarkdown } from './paper-validation.mjs';

const url = 'https://www.nature.com/articles/test';
const section = (title, body) => `<section data-title="${title}"><div class="c-article-section"><h2 class="c-article-section__title">${title}</h2><div class="c-article-section__content">${body}</div></div></section>`;
const html = body => `<html><body><article class="c-article-body"><div class="main-content">${body}</div></article></body></html>`;
const source = html(section('Main', '<p>First <i>important</i> statement.</p><p>Second statement.</p>') +
	section('Methods', '<h3 id="samples">Samples</h3><p>We measured 24 cells.</p><h3>Analysis</h3><p>We tested two groups.</p>'));
const markdown = '## Main\n\nFirst *important* statement.\n\nSecond statement.\n\n## Methods\n\n### Samples\n\nWe measured 24 cells.\n\n### Analysis\n\nWe tested two groups.\n';
const check = (md = markdown, input = source) => checkSourceSections(input, md, url);

test('checks ordered Nature headings and prose independently of word counts', () => {
	const result = check();
	assert.equal(result.version, sourceSectionsVersion);
	assert.equal(result.status, 'passed');
	assert.equal(result.expectedSections, 4);
	assert.equal(result.checkedParagraphs, 4);
	assert.equal(result.matchedParagraphs, 4);
	assert.equal(result.skippedParagraphs, 0);
	assert.equal(result.sections[2].id, 'samples');
	assert.equal(check('---\ntitle: Test\n---\n' + markdown.replaceAll('\n', '\r\n')).status, 'passed');
});

test('missing, changed, duplicated and moved paragraphs fail even with ample remaining content', () => {
	for (const md of [markdown.replace('Second statement.', ''), markdown.replace('24 cells', '42 cells'),
		markdown.replace('Second statement.', 'Second statement.\n\nSecond statement.'),
		markdown.replace('Second statement.', '').replace('### Samples', 'Second statement.\n\n### Samples'),
		markdown.replace('First *important* statement.\n\nSecond statement.', 'Second statement.\n\nFirst *important* statement.')]) {
		assert.equal(check(md).status, 'failed', md);
	}
	const result = check(markdown.replace('Second statement.', ''));
	const quality = assessMarkdown(markdown, { minWords: 1 }, { sourceSections: result });
	assert.deepEqual(quality.reasons, ['source-sections']);
	assert.equal(quality.sourceSections, result);
});

test('missing, repeated, reordered and misnested headings are not certified', () => {
	for (const md of [markdown.replace('### Samples', '### Measurements'), markdown.replace('### Samples', '#### Samples'),
		markdown.replace('## Main', '# Main'), markdown + '\n## Main\n\nDuplicate.',
		markdown.slice(markdown.indexOf('## Methods')) + '\n' + markdown.slice(0, markdown.indexOf('## Methods')),
		markdown.replace('### Samples', '### Analysis').replace('### Analysis\n\nWe tested', '### Samples\n\nWe tested')]) {
		assert.equal(check(md).status, 'failed', md);
	}
});

test('a subheading may share the title of another root section', () => {
	assert.equal(check(markdown.replace('### Samples', '### Main'), source.replace('>Samples</h3>', '>Main</h3>')).status, 'passed');
});

test('legitimate repeated paragraphs and headings retain their occurrence counts', () => {
	const input = html(section('Methods', '<h3>Trial</h3><p>Same.</p><p>Same.</p><h3>Trial</h3><p>Other.</p>'));
	const md = '## Methods\n\n### Trial\n\nSame.\n\nSame.\n\n### Trial\n\nOther.';
	assert.equal(check(md, input).status, 'passed');
	assert.equal(check(md.replace('Same.\n\n', ''), input).status, 'failed');
});

test('code, quotes, lists, raw HTML, images and YAML cannot impersonate missing prose', () => {
	for (const substitute of ['```text\nSecond statement.\n```', '> Second statement.', '- Second statement.',
		'<div>Second statement.</div>', '![Second statement.](image.png)']) {
		assert.equal(check(markdown.replace('Second statement.', substitute)).status, 'failed', substitute);
	}
	assert.equal(check('---\nnote: Second statement.\n---\n' + markdown.replace('Second statement.', '')).status, 'failed');
	assert.equal(check(markdown.replace('## Main', '```text\n## Main\n```')).status, 'failed');
});

test('only numeric local Nature citations normalize to corresponding footnote markers', () => {
	const input = html(section('Main', '<p>Evidence<sup><a href="#ref-CR1">1</a>,<a href="/articles/test#ref-CR23">23</a></sup> remains 1,23.</p>'));
	const md = '## Main\n\nEvidence[^1][^23] remains 1,23.\n\n[^1]: One\n[^23]: Two';
	assert.equal(check(md, input).status, 'passed');
	for (const changed of [md.replace('[^1][^23]', '[^12][^3]'), md.replace('1,23.', '123.'), md.replace('[^1][^23]', '123')]) {
		assert.equal(check(changed, input).status, 'failed');
	}
	assert.equal(check('## Main\n\nEvidence[^1][^23] remains 1,23.', input.replace('href="#ref-CR1"', 'href="https://other.example/#ref-CR1"')).status, 'failed');
});

test('math, dollar and inline image paragraphs are explicitly skipped, never counted as matched', () => {
	const input = html(section('Methods', '<p>Plain prose.</p><p>Formula <span class="mathjax-tex">\\(x_i\\)</span>.</p><p>Cost $5.</p><p>Inline <img src="eq.png">.</p>'));
	const result = check('## Methods\n\nPlain prose.', input);
	assert.equal(result.status, 'passed');
	assert.equal(result.checkedParagraphs, 1);
	assert.equal(result.matchedParagraphs, 1);
	assert.equal(result.skippedParagraphs, 3);
	assert.deepEqual(result.sections[0].skipped.map(item => item.paragraph), [2, 3, 4]);
});

test('figures, tables, lists, hidden content and material outside the main body are outside this check', () => {
	const extra = '<figure><h3>Figure</h3><p>Legend.</p></figure><table><tr><td><p>Cell.</p></td></tr></table><ul><li><p>List.</p></li></ul><p hidden>Hidden.</p>';
	assert.equal(check(markdown, source.replace('<p>First <i>', extra + '<p>First <i>').replace('</article>', '<section><h2>References</h2><p>Back matter.</p></section></article>')).status, 'passed');
});

test('unsupported hosts and layouts report not-applicable instead of passing', () => {
	for (const host of ['https://example.com', 'https://nature.com.example.com']) {
		assert.equal(checkSourceSections(source, markdown, host).reason, 'unsupported-publisher');
	}
	assert.equal(check(markdown, '<article><h2>Main</h2><p>Text.</p></article>').status, 'not-applicable');
	assert.equal(check(markdown, html('')).reason, 'no-supported-sections');
	assert.equal(check(markdown, source + source).reason, 'unsupported-source-structure');
});

test('recognized but malformed sections and invalid URLs fail closed with a diagnostic', () => {
	assert.equal(check(markdown, source.replaceAll('c-article-section__content', 'unknown')).status, 'failed');
	assert.match(checkSourceSections(source, markdown, 'not a URL').error, /Cannot verify/);
});

test('supports SpringerLink and BMC hosts including author-year citations', () => {
	const springerUrl = 'https://link.springer.com/article/10.1186/s12859-024-05935-y';
	const springerHtml = html(section('Results', '<p>Observed by Smith (<a data-test="citation-ref" href="/article/10.1186/s12859-024-05935-y#ref-CR1">2020</a>).</p>'));
	const bmcUrl = 'https://bmcbioinformatics.biomedcentral.com/articles/10.1186/s12859-024-05935-y';
	const bmcHtml = html(section('Results', '<p>Observed by Smith (<a data-test="citation-ref" href="/articles/10.1186/s12859-024-05935-y#ref-CR1">2020</a>).</p>'));
	const springerMd = '## Results\n\nObserved by Smith (2020 [^1]).\n\n[^1]: Smith (2020) Tool.\n';
	const springerResult = checkSourceSections(springerHtml, springerMd, springerUrl);
	assert.equal(springerResult.status, 'passed');
	assert.equal(springerResult.publisher, 'springer-nature');
	const bmcResult = checkSourceSections(bmcHtml, springerMd, bmcUrl);
	assert.equal(bmcResult.status, 'passed');
	assert.equal(bmcResult.publisher, 'springer-nature');
	// Cross-article path mismatch between HTML citation link (/article/) and BMC URL (/articles/) stays rejected.
	assert.equal(checkSourceSections(springerHtml, springerMd, bmcUrl).status, 'failed');
	assert.equal(checkSourceSections(springerHtml, springerMd.replace('2020 [^1]', '2021 [^1]'), springerUrl).status, 'failed');

	const reorderedHtml = `<html><body><article class="c-article-body"><div class="main-content">${section('Results', '<p>Feedback circuit (Chau et al, <a data-test="citation-ref" href="/article/10.1186/s12859-024-05935-y#ref-CR15">2012</a>).</p>')}</div><ul class="c-article-references"><li><p id="ref-CR102">Boyd (1996)</p></li><li><p id="ref-CR15">Chau (2012)</p></li></ul></article></body></html>`;
	const reorderedMd = '## Results\n\nFeedback circuit (Chau et al, 2012 [^2]).\n\n[^1]: Boyd (1996)\n\n[^2]: Chau (2012)\n';
	assert.equal(checkSourceSections(reorderedHtml, reorderedMd, springerUrl).status, 'passed');
	assert.equal(checkSourceSections(reorderedHtml, reorderedMd.replace('[^2]', '[^15]'), springerUrl).status, 'failed');
});
