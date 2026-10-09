import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessMarkdown, bodyCheckVersion } from './paper-validation.mjs';

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
