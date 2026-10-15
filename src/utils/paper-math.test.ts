// @vitest-environment jsdom
import { expect, test } from 'vitest';
import Defuddle from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';
import { clip } from '../api';
import { parseForClip } from './clip-utils';
import { prepareDocumentForExtraction } from './publisher-figures';
import { checkMathPreservation, retainMathForSnapshot } from './paper-math.mjs';
import { mathHtml } from '../../scripts/fixtures/mathjax.mjs';

const url = 'https://www.cell.com/cell/fulltext/synthetic-math';
const parse = () => new DOMParser().parseFromString(mathHtml, 'text/html');

test('cleaned check snapshots retain CHTML spacing and still detect removed formulas', () => {
	const source = parse();
	const markdown = createMarkdownContent(parseForClip(source).content, url);
	const snapshot = source.cloneNode(true) as Document;
	retainMathForSnapshot(snapshot);
	snapshot.querySelectorAll('script, style').forEach(element => element.remove());
	snapshot.querySelectorAll('*').forEach(element => element.removeAttribute('style'));
	const roundtrip = new DOMParser().parseFromString(snapshot.documentElement.outerHTML, 'text/html');
	expect(checkMathPreservation(roundtrip, markdown)).toMatchObject({ status: 'passed', expected: 8, matched: 8 });
	expect(checkMathPreservation(roundtrip, markdown.replace('$z$', ''))).toMatchObject({ status: 'failed', expected: 8, matched: 7 });
	expect(source.querySelector('mjx-mspace')?.getAttribute('style')).toContain('0.5em');
	expect(source.querySelector('mjx-container')?.hasAttribute('data-latex')).toBe(false);
});

test('snapshot cleanup preserves sibling TeX and its display mode, without blessing unsupported math', () => {
	const source = new DOMParser().parseFromString('<mjx-container></mjx-container><script type="math/tex; mode=display">x_1</script><mjx-container><mjx-unknown></mjx-unknown></mjx-container>', 'text/html');
	retainMathForSnapshot(source);
	source.querySelectorAll('script').forEach(element => element.remove());
	expect(checkMathPreservation(source, '$$x_1$$')).toMatchObject({ expected: 2, matched: 1, status: 'failed' });
	expect(checkMathPreservation(source, '$x_1$')).toMatchObject({ matched: 0, status: 'failed' });
});

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
