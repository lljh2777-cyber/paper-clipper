import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { parseHTML } from 'linkedom';
import { mathInventory, prepareMath, checkMathPreservation } from '../src/utils/paper-math.mjs';
import { assessPaper } from './paper-validation.mjs';
import { mathHtml, container, token } from './fixtures/mathjax.mjs';

const parse = html => parseHTML(html).document;
const expected = document => mathInventory(document).map(({ latex, block }) => block ? `\n$$\n${latex}\n$$\n` : `$${latex}$`).join('\n\n');

test('reconstructs script roles, Unicode fonts, fractions and real/spaced matrix layouts', () => {
	const doc = parse(mathHtml);
	const items = mathInventory(doc);
	assert.equal(items.length, 8);
	assert.ok(items.every(item => !item.error));
	assert.match(items[0].latex, /\\boldsymbol\{x\}_\{i\}/);
	assert.equal(items[1].latex, '\\mathbb{R}');
	assert.equal(items[2].block, true);
	assert.equal((items[2].latex.match(/\\hspace\{0.5em\}/g) || []).length, 4);
	assert.doesNotMatch(items[2].latex, /\\left\(/);
	assert.match(items[3].latex, /a & b & c \\\\ d & e & f/);
	assert.equal(items[4].latex, '\\frac{1}{q_{c_{i}}}');
	assert.equal(items[5].latex, '\\sum_{i = 1}^{K}');
	prepareMath(doc);
	assert.equal(doc.querySelectorAll('math').length, 8);
	assert.equal(doc.querySelectorAll('math[display="block"]').length, 2);
	assert.equal(doc.querySelectorAll('mspace[width="0.5em"]').length, 4);
	assert.doesNotMatch(doc.body.innerHTML, /PCSPACE|PCGROUP|aria-hidden/);
});

test('explicit TeX or assistive MathML wins over rendered or unsupported CHTML', () => {
	const doc = parse('<html><body>' + container('<mjx-unknown></mjx-unknown>').replace('<mjx-math', '<math><semantics><mi>x</mi><annotation encoding="application/x-tex">x_i</annotation></semantics></math><mjx-math') +
		'<mjx-container><mjx-assistive-mml><math display="block"><mfrac><mn>1</mn><mi>x</mi></mfrac></math></mjx-assistive-mml></mjx-container></body></html>');
	const items = mathInventory(doc);
	assert.deepEqual(items.map(e => e.latex), ['x_i', '\\frac{1}{x}']);
	assert.equal(items[1].block, true);
	const scripts = parse('<html><body><mjx-container></mjx-container><script type="math/tex">x_i</script>' + container(token('y')) + '</body></html>');
	assert.deepEqual(mathInventory(scripts).map(item => item.latex), ['x_i', 'y']);
	prepareMath(scripts);
	assert.equal(scripts.querySelectorAll('script').length, 0);
});

test('unknown or unloaded math fails explicitly, without mutating the input', () => {
	for (const body of ['<mjx-lazy></mjx-lazy>', '<mjx-msqrt></mjx-msqrt>', '<mjx-mi><mjx-c class="mjx-c78"></mjx-c></mjx-mi>', '<mjx-mspace></mjx-mspace>']) {
		const doc = parse('<html><body>' + container(body) + '</body></html>');
		const before = doc.toString();
		assert.throws(() => prepareMath(doc), /formula.*could not be safely converted/);
		assert.equal(doc.toString(), before);
		assert.equal(checkMathPreservation(doc, '').status, 'failed');
	}
});

test('preservation checks formulas, duplicates, display mode, font and matrix structure', () => {
	const doc = parse(mathHtml), md = expected(doc);
	assert.equal(checkMathPreservation(doc, md).matched, 8);
	for (const bad of [md.replace('$z$', ''), md.replace('mathbb', 'mathrm'), md.replace(' & b', ' b'), md.replaceAll('$$', '$'),
		'```latex\n' + md + '\n```', '`' + md.replaceAll('\n', ' ') + '`', '<div>\n' + md + '\n</div>']) {
		assert.equal(checkMathPreservation(doc, bad).status, 'failed');
	}
	assert.equal(checkMathPreservation(parse('<html><body>No formulas</body></html>'), '').status, 'not-applicable');
	assert.equal(mathInventory(parse('<html><body><pre>' + container(token('x')) + '</pre><aside>' + container(token('y')) + '</aside></body></html>')).length, 0);
});

test('comparison preserves TeX command boundaries and significant text spaces', () => {
	const source = parse('<html><body><mjx-container data-latex="\\alpha x + \\text{two words}"></mjx-container></body></html>');
	assert.equal(checkMathPreservation(source, '$\\alpha x + \\text{two words}$').status, 'passed');
	for (const bad of ['$\\alphax + \\text{two words}$', '$\\alpha x + \\text{twowords}$']) assert.equal(checkMathPreservation(source, bad).status, 'failed');
	assert.equal(checkMathPreservation(source, 'Cost $5; formula $\\alpha x + \\text{two words}$.').status, 'passed');
});

test('formula loss is a source-preservation failure, not proof of incomplete source HTML', () => {
	const validBody = '## Results\n\n' + 'measurement '.repeat(120) + '\n\n## Methods\n\n' + 'procedure '.repeat(120);
	const result = assessPaper(mathHtml, validBody, 'https://example.org/paper', { minWords: 100 });
	assert.equal(result.passed, false);
	assert.equal(result.completeness.status, 'passed-heuristics');
	assert.equal(result.preservation.status, 'failed');
	assert.equal(result.formulaPreservation.expected, 8);
	assert.ok(result.reasons.includes('formula-preservation'));
	assert.equal(assessPaper(mathHtml, validBody + '\n\n' + expected(parse(mathHtml)), 'https://example.org/paper', { minWords: 100 }).passed, true);
});

test('the built CLI retains synthetic formulas through the shared extraction pipeline', () => {
	const markdown = execFileSync(process.execPath, ['dist/cli.cjs', 'https://example.org/paper', '--html', '-', '-t', 'src/utils/fixtures/templates/minimal.json'], { input: mathHtml, encoding: 'utf8' });
	assert.equal(checkMathPreservation(parse(mathHtml), markdown).status, 'passed');
});
