import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveRequirements, assessMarkdown, assessPaper, bodyCheckVersion, qualitySummary, withOutputQuality } from './paper-validation.mjs';
import { reviewHtml, reviewMarkdown, reviewParagraphs, reviewDoi, reviewUrl } from './fixtures/nature-review.mjs';

const paragraph = 'Cells were measured across independent biological samples. '.repeat(80);
const valid = `## Results\n\n${paragraph}\n\n## Methods\n\n${paragraph}`;
const check = (markdown, options = {}, page = {}) => assessMarkdown(markdown, { minWords: 1000, ...options }, page);

test('empty main sections cannot use funding text to meet the body threshold', () => {
	const result = check(`## Main\n\n## Methods\n\n## Funding\n\n${'grant '.repeat(1100)}`);
	assert.equal(result.passed, false);
	assert.equal(result.wordsBeforeReferences, 1106);
	assert.equal(result.mainBodyWords, 0);
	assert.deepEqual(result.mainSections, []);
	assert.ok(result.reasons.includes('empty-main-section:Main'));
	assert.ok(result.reasons.includes('empty-main-section:Methods'));
});

test('real headings at every Markdown level and setext headings are recognized', () => {
	for (let level = 1; level <= 6; level++) {
		const prefix = '#'.repeat(level);
		const result = check(`${prefix} Introduction\n\n${'body '.repeat(600)}\n\n${prefix} Methods\n\n${'method '.repeat(600)}`, { requiredSections: ['Methods'] });
		assert.equal(result.passed, true, `level ${level}`);
		assert.equal(result.mainBodyWords, 1200);
	}
	assert.equal(check(`Introduction\n============\n\n${paragraph}\n\nMethods\n-------\n\n${paragraph}`).passed, true);
});

test('fenced and indented code, quoted headings and list headings are not article sections', () => {
	for (const markdown of [
		`\`\`\`markdown\n${valid}\n\`\`\``,
		valid.split('\n').map(line => `    ${line}`).join('\n'),
		valid.split('\n').map(line => `> ${line}`).join('\n'),
		`- ## Results\n\n  ${paragraph}\n\n- ## Methods\n\n  ${paragraph}`,
	]) {
		const result = check(markdown);
		assert.equal(result.passed, false);
		assert.deepEqual(result.headings, []);
		assert.equal(result.mainBodyWords, 0);
	}
});

test('code, quotes, tables, image alt text, HTML blocks and display math do not populate empty sections', () => {
	for (const content of [
		`\`\`\`\n${paragraph}\n\`\`\``, `> ${paragraph}`,
		`| one | two |\n| --- | --- |\n| ${paragraph} | ${paragraph} |`,
		`![${paragraph}](https://example.com/figure.png)`,
		`<div>${paragraph}</div>`, `<table><tr><td>${paragraph}</td></tr></table>`,
		`$$\n${paragraph}\n$$`, `<span hidden>${paragraph}</span>`,
	]) {
		const result = check(`## Results\n\n${content}\n\n## Methods\n\n${content}`);
		assert.equal(result.passed, false, content.slice(0, 40));
		assert.equal(result.mainBodyWords, 0);
	}
});

test('unheaded text, an abstract and unrelated sibling sections cannot pad the threshold', () => {
	const result = check(`${paragraph}\n\n## Abstract\n\n${paragraph}\n\n## Results\n\nShort result.\n\n## Methods\n\nShort method.\n\n## Unrelated\n\n${paragraph}`);
	assert.equal(result.passed, false);
	assert.equal(result.mainBodyWords, 4);
	assert.deepEqual(result.reasons, ['too-short']);
});

test('nested sections count prose once, including ordinary subsections and procedure lists', () => {
	const result = check('## Main\n\n### Results\n\n#### Sample observations\n\nFour words appear here.\n\n### Methods\n\n1. Collect tissue samples.\n2. Measure gene expression.', { minWords: 10 });
	assert.equal(result.passed, true);
	assert.equal(result.mainBodyWords, 10);
	assert.equal(result.sections.find(section => section.heading === 'Main').words, 10);
	assert.equal(result.sections.find(section => section.heading === 'Results').words, 4);
	assert.equal(result.sections.find(section => section.heading === 'Methods').words, 6);
});

test('excluded subsections cannot fill their parent or smuggle main headings inside back matter', () => {
	const result = check(`## Main\n\n### Funding\n\n${paragraph}\n\n#### Methods\n\n${paragraph}\n\n## Results\n\n${paragraph}`);
	assert.equal(result.passed, false);
	assert.ok(result.reasons.includes('empty-main-section:Main'));
	assert.deepEqual(result.mainSections, ['Results']);
	assert.equal(result.sections.find(section => section.heading === 'Methods').excluded, true);
});

test('references and metadata do not count but a later independent Methods section can', () => {
	const result = check(`## Results\n\n${paragraph}\n\n## References\n\n${paragraph}\n\n### Methods\n\n${paragraph}\n\n## Methods\n\n${paragraph}`);
	assert.equal(result.passed, true);
	assert.equal(result.mainBodyWords, 1120);
	assert.ok(result.wordsBeforeReferences < result.mainBodyWords);
});

test('common back-matter labels are excluded at any depth', () => {
	for (const label of ['Funding', 'Acknowledgments', 'Acknowledgements', 'Author contributions', 'Authors\u2019 contributions',
		'Author information', 'Declarations', 'Ethics declarations', 'Competing interests', 'Conflict of interest',
		'Data availability', 'Availability of data and materials', 'Code availability', 'Supplementary information',
		'Additional information', 'References and notes', 'Bibliography']) {
		const result = check(`## Results\n\nA result.\n\n### ${label}\n\n${paragraph}\n\n## Methods\n\nA method.`, { minWords: 10 });
		assert.equal(result.mainBodyWords, 4, label);
		assert.equal(result.passed, false, label);
	}
});

test('numbering, rich heading text, CRLF and YAML do not hide or invent headings', () => {
	const markdown = `\uFEFF---\ntitle: Example\nsummary: |\n  ## Main\n  ${paragraph}\n---\n## **1. Introduction**\n\n${paragraph}\n\n### [2.1 Methods](https://example.com) ###\n\n${paragraph}`;
	const result = check(markdown.replace(/\n/g, '\r\n'), { requiredSections: ['2.1 methods'] });
	assert.equal(result.passed, true);
	assert.deepEqual(result.headings, ['1. Introduction', '2.1 Methods']);
	assert.equal(result.mainBodyWords, 1120);
	assert.equal(result.bodyCheck, bodyCheckVersion);
});

test('required sections must be outside excluded regions and contain prose', () => {
	const missing = check(valid, { requiredSections: ['Discussion'] });
	assert.deepEqual(missing.reasons, ['missing-section:Discussion']);
	const empty = check(`${valid}\n\n## Discussion`, { requiredSections: ['Discussion'] });
	assert.ok(empty.reasons.includes('empty-section:Discussion'));
	assert.ok(empty.reasons.includes('empty-main-section:Discussion'));
	assert.equal(empty.passed, false);
	const excluded = check(`${valid}\n\n## References\n\n### Discussion\n\n${paragraph}`, { requiredSections: ['Discussion'] });
	assert.deepEqual(excluded.reasons, ['missing-section:Discussion']);
});

test('duplicate headings cannot satisfy the two-section minimum', () => {
	const result = check(`## Methods\n\n${paragraph}\n\n## METHODS\n\n${paragraph}`);
	assert.equal(result.mainSections.length, 1);
	assert.ok(result.reasons.includes('missing-main-sections'));
});

test('existing access, identity, equation and caption gates remain independent', () => {
	const page = { preview: true, challenge: true, unrenderedEquations: true,
		figureCaptions: { status: 'failed' }, paperIdentity: { status: 'failed' } };
	const result = check(valid, {}, page);
	assert.deepEqual(result.reasons, ['subscription-preview', 'access-challenge', 'unrendered-equations', 'figure-captions', 'paper-identity']);
	assert.equal(result.paperIdentity, page.paperIdentity);
	assert.equal(result.figureCaptions, page.figureCaptions);
	assert.equal(check(`${valid}\n\nThis is a preview of subscription content`).passed, false);
});

test('invalid thresholds fail closed instead of silently disabling the length gate', () => {
	for (const minWords of [undefined, NaN, 0, -1, 1.5, '1000']) assert.throws(() => check(valid, { minWords }), /positive integer/);
});

test('unknown publishers pass body heuristics without claiming source preservation or completeness', () => {
	const html = '<html><head><title>Public synthetic fixture</title></head><body><article>Source</article></body></html>';
	for (const url of ['https://publisher.example/paper', 'https://www.nature.com/articles/unknown-layout']) {
		const result = assessPaper(html, valid, url, { minWords: 1000 });
		assert.equal(result.passed, true);
		assert.equal(result.completeness.status, 'passed-heuristics');
		assert.equal(result.preservation.status, 'unverified');
		assert.equal(result.coverage.status, 'heuristic-only');
		assert.equal(result.coverage.comparisons.sourceSections, 'not-applicable');
		assert.match(qualitySummary(result), /Not proof of full text/);
	}
	assert.match(qualitySummary(), /unchecked.*unverified.*not-run/);
});

test('source preservation failures and skipped math do not become completeness or coverage claims', () => {
	const section = (title, prose) => `<section data-title="${title}"><div><h2 class="c-article-section__title">${title}</h2><div class="c-article-section__content"><p>${prose}</p></div></div></section>`;
	const html = `<html><body><article class="c-article-body"><div class="main-content">${section('Results', paragraph)}${section('Methods', paragraph + '</p><p><math><mi>x</mi></math>')}</div></article></body></html>`;
	const assess = markdown => assessPaper(html, markdown, 'https://www.nature.com/articles/synthetic', { minWords: 1000 });
	const passed = assess(valid);
	assert.equal(passed.passed, true);
	assert.equal(passed.preservation.status, 'passed-within-scope');
	assert.equal(passed.coverage.status, 'partial-source');
	assert.equal(passed.coverage.skippedParagraphs, 1);
	const changed = assess(valid.replace('Cells were', 'Cells are'));
	assert.equal(changed.completeness.status, 'passed-heuristics');
	assert.equal(changed.preservation.status, 'failed');
	assert.equal(changed.passed, false);
	const output = assess('# Title only');
	const combined = withOutputQuality(passed, output);
	assert.equal(combined.completeness.status, 'failed');
	assert.equal(combined.preservation.status, 'failed');
	assert.ok(combined.reasons.includes('output-too-short'));
	assert.equal(combined.outputQuality, output);
	assert.doesNotThrow(() => JSON.stringify(withOutputQuality(passed, passed)));
});

test('archive requirements keep the stronger saved/current threshold, required sections and DOI', () => {
	assert.equal(archiveRequirements().minWords, 1000);
	assert.equal(archiveRequirements({}, { minWords: 10 }).minWords, 1000);
	assert.equal(archiveRequirements({ minWords: 2000 }, { minWords: 1000 }).minWords, 2000);
	assert.equal(archiveRequirements({ minWords: 1000 }, { minWords: 2000 }).minWords, 2000);
	assert.deepEqual(archiveRequirements({ requiredSections: ['Methods'], expectedDoi: '10.1234/ABC' }, { requiredSections: ['Discussion'] }),
		{ minWords: 1000, requiredSections: ['Methods', 'Discussion'], expectedDoi: '10.1234/abc' });
	assert.throws(() => archiveRequirements({ expectedDoi: '10.1234/a' }, { expectedDoi: '10.1234/b' }), /DOI conflict/);
	for (const invalid of [{ minWords: 0 }, { minWords: '100' }, { requiredSections: 'Methods' }, { requiredSections: [''] }]) {
		assert.throws(() => archiveRequirements(invalid));
		assert.throws(() => archiveRequirements({}, invalid));
	}
});

test('single Main reviews require publisher type plus a complete source-prose comparison at the unchanged threshold', () => {
	const result = assessPaper(reviewHtml, reviewMarkdown, reviewUrl, { minWords: 1000, expectedDoi: reviewDoi });
	assert.equal(result.passed, true);
	assert.equal(result.sectionRule, 'nature-review-source-v1');
	assert.equal(result.reviewStructure.requiredWords, 1000);
	assert.ok(result.reviewStructure.matchedWords >= 1000);
	assert.equal(result.sourceSections.checkedWords, result.sourceSections.matchedWords);
	assert.equal(result.paperIdentity.status, 'passed');
	assert.equal(result.completeness.status, 'passed-heuristics');
	assert.equal(result.coverage.status, 'partial-source');
	assert.equal(check(reviewMarkdown).passed, false);
	assert.equal(assessPaper(reviewHtml, reviewMarkdown, reviewUrl, { minWords: 2000 }).passed, false);
	assert.equal(assessPaper(reviewHtml, reviewMarkdown, reviewUrl, { minWords: 1000, requiredSections: ['Methods'] }).passed, false);
});

test('review metadata alone cannot certify absent, skipped, altered, duplicated or padded source prose', () => {
	for (const [html, markdown, url = reviewUrl] of [
		[reviewHtml.replace('ReviewPaper', 'Article'), reviewMarkdown],
		[reviewHtml.replace('<meta name="dc.type" content="ReviewPaper">', ''), reviewMarkdown],
		[reviewHtml.replace('</head>', '<meta name="dc.type" content="Article"></head>'), reviewMarkdown],
		[reviewHtml, reviewMarkdown, 'https://publisher.example/review'],
		[reviewHtml.replace('main-content', 'unsupported'), reviewMarkdown],
		[reviewHtml.replace('<p>', '<p><math><mi>x</mi></math>'), reviewMarkdown],
		[reviewHtml, reviewMarkdown.replace(reviewParagraphs[0], '')],
		[reviewHtml, reviewMarkdown.replace('Independent', 'Changed')],
		[reviewHtml, reviewMarkdown + reviewParagraphs[0]],
		[reviewHtml, reviewMarkdown + '\n## Main\n\nExtra duplicate heading.'],
		[reviewHtml.replace(reviewParagraphs[0], 'Short prose.').replace(reviewParagraphs[1], 'Another sentence.'),
			'## Main\n\nShort prose.\n\nAnother sentence.\n\n' + paragraph + paragraph],
	]) {
		const result = assessPaper(html, markdown, url, { minWords: 1000 });
		assert.equal(result.passed, false);
		assert.ok(result.reasons.includes('missing-main-sections'));
	}
});

test('review structure does not bypass access, DOI or caption checks, including custom output checks', () => {
	for (const [html, markdown, doi = reviewDoi, reason] of [
		[reviewHtml, reviewMarkdown, '10.1234/wrong', 'paper-identity'],
		[reviewHtml.replace('</article>', '<p>This is a preview of subscription content</p></article>'), reviewMarkdown, reviewDoi, 'subscription-preview'],
		[reviewHtml.replace('</article>', '<figure><figcaption>Fig. 1: Test.</figcaption><div class="c-article-section__figure-description"><p>Required legend.</p></div></figure></article>'), reviewMarkdown, reviewDoi, 'figure-captions'],
	]) {
		const result = assessPaper(html, markdown, reviewUrl, { minWords: 1000, expectedDoi: doi });
		assert.equal(result.passed, false);
		assert.ok(result.reasons.includes(reason));
	}
	const assess = md => assessPaper(reviewHtml, md, reviewUrl, { minWords: 1000 });
	assert.equal(withOutputQuality(assess(reviewMarkdown), assess('# Title only')).passed, false);
});
