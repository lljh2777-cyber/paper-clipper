// @vitest-environment jsdom
import { expect, test } from 'vitest';
import Defuddle from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';
import { clip } from '../api';
import { parseForClip } from './clip-utils';
import { prepareDocumentForExtraction } from './publisher-figures';
import { checkMathPreservation } from './paper-math.mjs';
import { mathHtml } from '../../scripts/fixtures/mathjax.mjs';

const url = 'https://www.cell.com/cell/fulltext/synthetic-math';
const parse = () => new DOMParser().parseFromString(mathHtml, 'text/html');

test('math normalization is copy-only, idempotent and independent of the Cell citation adapter', () => {
	const source = parse(), before = source.documentElement.outerHTML;
	const prepared = prepareDocumentForExtraction(source, url);
	expect(source.documentElement.outerHTML).toBe(before);
	expect(prepared.querySelectorAll('math')).toHaveLength(8);
	expect(prepareDocumentForExtraction(prepared, url)).toBe(prepared);
});

test('sync and async extension extraction retain inline and display math', async () => {
	for (const asyncMode of [false, true]) {
		const source = parse();
		const parser = new Defuddle(prepareDocumentForExtraction(source, url), { url });
		const result = asyncMode ? await parser.parseAsync() : parser.parse();
		const markdown = createMarkdownContent(result.content, url);
		expect(checkMathPreservation(source, markdown)).toMatchObject({ status: 'passed', expected: 8, matched: 8 });
		expect(markdown).not.toMatch(/PCSPACE|PCGROUP/);
	}
});

test('manual save and API use the same math protection', async () => {
	const source = parse();
	Object.defineProperty(source, 'URL', { value: url });
	const manual = createMarkdownContent(parseForClip(source).content, url);
	const result = await clip({ html: mathHtml, url, documentParser: new DOMParser(), template: {
		id: 'math', name: 'Math', behavior: 'create', noteNameFormat: '{{title}}', path: '', noteContentFormat: '{{content}}', properties: []
	} });
	expect(checkMathPreservation(source, manual).status).toBe('passed');
	expect(checkMathPreservation(source, result.content).status).toBe('passed');
});
