import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditSource, compareReference, markdownMetrics, runAcceptance } from './accept-papers.mjs';
import { auditNatureLegends } from './paper-captions.mjs';

test('reference comparison strips only frontmatter and enforces declared tolerances', () => {
	assert.equal(compareReference('---\ntitle: a\n---\n## Results\nText\n', '## Results\nText\n').passed, true);
	assert.equal(compareReference('## Results\nText\n', '## Results\nText').passed, false);
	assert.equal(compareReference('## Results\nText\n', '## Results\nText', { comparison: 'whitespace' }).passed, true);
	assert.equal(compareReference('## Results\nChanged\n', '## Results\nText\n', { comparison: 'whitespace' }).passed, false);
});

test('known exclusions and exact reviewed replacements never silently rebaseline', () => {
	const reference = '## Abstract\nBody\n\n## Ask a research question\nUnrelated module.\n\n## Results\nOld math\n';
	const actual = '## Abstract\nBody\n\n## Results\nNew math\n';
	const rules = { comparison: 'whitespace', excludeReferenceSections: ['Ask a research question'], referenceReplacements: [{ from: 'Old math', to: 'New math', reason: 'Reviewed formula correction.' }] };
	const result = compareReference(actual, reference, rules);
	assert.equal(result.passed, true);
	assert.equal(result.exactBeforeExclusions, false);
	assert.deepEqual(result.excludedReferenceSections, ['Ask a research question']);
	assert.equal(result.reviewedReferenceReplacements.length, 1);
	assert.throws(() => compareReference(actual, reference + 'Old math', rules), /exactly once/);
	assert.throws(() => compareReference(actual, reference.replace('Old math', 'Changed'), rules), /exactly once/);
	assert.equal(compareReference(actual.replace('Body', 'Lost paragraph'), reference, rules).passed, false);
});

test('Markdown parser counts GFM and HTML tables, links, images and dollar math', () => {
	const metrics = markdownMetrics('## Results\n$x_i$\n\n$$\nx^2\n$$\n\n![Figure](https://example.com/f.png)\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<table><tr><td colspan="2">Merged</td></tr></table>\n\n[^1]: Source\n');
	assert.equal(metrics.tables, 2);
	assert.equal(metrics.tableCells, 5);
	assert.equal(metrics.images, 1);
	assert.equal(metrics.mathExpressions, 2);
	assert.equal(metrics.displayEquations, 1);
	assert.equal(metrics.footnoteDefinitions, 1);
});

test('source audit detects missing citations, captions, images and altered table cells', () => {
	const html = '<html><body><a class="ref-tip" href="#r1">1</a><figcaption>Figure details</figcaption><img src="/fig.png"><table><tr><th>Value</th></tr><tr><td>42</td></tr></table></body></html>';
	const markdown = '[1](https://example.com/paper#r1)\n\nFigure details\n\n![Figure](/fig.png)\n\n| Value |\n| --- |\n| 42 |\n';
	const selectors = { links: 'a.ref-tip', captions: 'figcaption', images: 'img', tables: 'table' };
	assert.ok(auditSource(html, markdown, 'https://example.com/paper', selectors).every(check => check.passed));
	assert.ok(auditSource(html, '', 'https://example.com/paper', selectors).every(check => !check.passed));
	assert.equal(auditSource(html, markdown.replace('42', '43'), 'https://example.com/paper', { tables: 'table' })[0].passed, false);
	assert.equal(auditSource(html, markdown, 'https://example.com/paper', { images: '.missing' })[0].passed, false);
});

test('missing local samples are failures, not silently skipped or accepted', async () => {
	const root = fileURLToPath(new URL('../', import.meta.url));
	const output = path.join(root, 'output/browser-fetch/tests');
	await mkdir(output, { recursive: true });
	const directory = await mkdtemp(path.join(output, 'acceptance-'));
	const manifest = { schemaVersion: 1, cases: [{ id: 'missing', name: 'Missing fixture', url: 'https://example.com/paper', captureReport: path.join(directory, 'absent.json'), expectedExit: 0 }] };
	const result = await runAcceptance(manifest, directory);
	assert.equal(result.exitCode, 1);
	assert.equal(result.report.items[0].status, 'failed');
	assert.match(result.report.items[0].errors[0], /ENOENT/);
	assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).exitCode, 1);
	await assert.rejects(runAcceptance({ schemaVersion: 1, cases: [] }, directory), /nonempty/);
	await assert.rejects(runAcceptance({ ...manifest, cases: [...manifest.cases, ...manifest.cases] }, directory), /unique/);
});

test('source audit preserves repeated references and tables instead of comparing only sets', () => {
	const table = '<table><tr><td>42</td></tr></table>';
	const link = '<a class="ref-tip" href="#r1">1</a>';
	const html = `<html><body>${table}${table}${link}${link}</body></html>`;
	const markdown = `${table}\n\n[1](https://example.com/paper#r1)`;
	const result = auditSource(html, markdown, 'https://example.com/paper', { tables: 'table', links: 'a.ref-tip' });
	assert.deepEqual(result.map(check => check.missing), [1, 1]);
});

test('Nature legend audit requires full text, matching figure position, external links and no duplicates', () => {
	const html = '<html><body><figure><figcaption>Fig. 1: Overview.</figcaption><div class="c-article-section__figure-description"><p><b>a</b>, Full legend <a href="/data">data</a> plus x<sup>2</sup> and reference<sup>34</sup>.</p></div></figure></body></html>';
	const legend = '**a**, Full legend [data](https://www.nature.com/data) plus x<sup>2</sup> and reference[^34].';
	const before = '![Figure](https://example.com/a.png)\n\nFig. 1: Overview.\n\nNext paragraph.\n';
	const after = before.replace('Next paragraph.', `${legend}\n\nNext paragraph.`);
	const url = 'https://www.nature.com/articles/test';
	assert.equal(auditNatureLegends(html, after, url).passed, true);
	for (const bad of [before, after.replace('Full legend', 'Shortened'), after.replace('/data)', '/wrong)'), after + '\n' + legend, after.replace(`${legend}\n\nNext paragraph.`, `Next paragraph.\n\n${legend}`)]) {
		assert.equal(auditNatureLegends(html, bad, url).passed, false);
	}
	assert.equal(auditNatureLegends('<html></html>', after, url).passed, false);
	const rules = { sourceHtml: html, url, referenceMissingNatureLegends: 1 };
	assert.equal(compareReference(after, before, rules).passed, true);
	assert.equal(compareReference(after.replace('Next paragraph.', 'Unrelated change.'), before, rules).passed, false);
	assert.throws(() => compareReference(before, before, rules), /did not pass/);
	assert.throws(() => compareReference(after, after, rules), /already contains/);
	assert.throws(() => compareReference(after, before, { ...rules, referenceMissingNatureLegends: 2 }), /declared count/);
});

test('Nature citation links may become defined footnotes, but other fragment links must remain', () => {
	const url = 'https://www.nature.com/articles/test';
	const html = `<html><body><figure><figcaption>Fig. 1.</figcaption><div class="c-article-section__figure-description"><p>Reference<a href="${url}#ref-CR34">34</a> and <a href="#MOESM1">7a</a>.</p></div></figure></body></html>`;
	const markdown = `Fig. 1.\n\nReference[^34] and [7a](${url}#MOESM1).\n\n[^34]: Author, source.\n`;
	assert.equal(auditNatureLegends(html, markdown, url).passed, true);
	assert.equal(auditNatureLegends(html, markdown.replace('[^34]: Author, source.', ''), url).passed, false);
	assert.equal(auditNatureLegends(html, markdown.replace(`[7a](${url}#MOESM1)`, '7a'), url).passed, false);
	assert.equal(auditNatureLegends(html.replace(url + '#ref-CR34', 'https://other.example/#ref-CR34'), markdown, url).passed, false);
});
