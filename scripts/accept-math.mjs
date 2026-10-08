import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { Marked } from 'marked';
import { parseHTML } from 'linkedom';
import { MathMLToLaTeX } from 'mathml-to-latex';
import { stripFrontmatter } from './accept-papers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const rendererUrl = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js';

function expressions(markdown) {
	const text = new Marked().lexer(stripFrontmatter(markdown)).filter(token => token.type !== 'code').map(token => token.raw).join('');
	return [...text.matchAll(/(?<![\\$])\$\$([\s\S]*?)(?<!\\)\$\$|(?<![\\$])\$((?:\\.|[^$\\\n])+?)\$(?!\$)/g)]
		.map(match => ({ tex: match[1] ?? match[2], display: match[1] !== undefined }));
}

export async function main(args = process.argv.slice(2)) {
	const { values } = parseArgs({ args, options: { before: { type: 'string' }, markdown: { type: 'string' }, 'source-html': { type: 'string' }, 'equation-id': { type: 'string' }, 'output-dir': { type: 'string' } } });
	if (!values.before || !values.markdown) throw new Error('Usage: npm run accept:math -- --before <backup.md> --markdown <repaired.md> [--source-html <capture.html> --equation-id <id>] [--output-dir <directory>]\nDownloads the pinned public MathJax renderer, then renders locally with browser networking blocked.');
	if (!!values['source-html'] !== !!values['equation-id']) throw new Error('--source-html and --equation-id must be used together.');
	const before = await readFile(path.resolve(values.before), 'utf8');
	const after = await readFile(path.resolve(values.markdown), 'utf8');
	let expected = before.replace(/\\hdots\b/g, '\\cdots');
	let reviewedEquation;
	if (values['source-html']) {
		const htmlPath = path.resolve(values['source-html']);
		const math = parseHTML(await readFile(htmlPath, 'utf8')).document.getElementById(values['equation-id']);
		assert.equal(math?.localName, 'math');
		const originalTex = math.textContent.replace(/\u00a0/g, ' ');
		const correctedTex = MathMLToLaTeX.convert(math.outerHTML);
		assert.equal(expected.split(`$${originalTex}$`).length, 2, 'Flattened source equation must match exactly once.');
		expected = expected.replace(`$${originalTex}$`, () => `$${correctedTex}$`);
		reviewedEquation = { htmlPath, mathId: values['equation-id'], originalTex, correctedTex };
	}
	assert.ok(after === expected, 'Only the reviewed, source-backed math replacements may differ.');
	const original = expressions(before);
	const corrected = expressions(after);
	assert.equal(corrected.length, original.length);
	const changed = original.map((entry, index) => entry.tex !== corrected[index].tex ? index : -1).filter(index => index >= 0);
	assert.ok(changed.length > 0, 'Expected at least one repaired formula.');
	const output = path.resolve(values['output-dir'] ?? path.join(root, 'output/playwright/paper-math'));
	await mkdir(output, { recursive: true });
	const directory = await mkdtemp(path.join(output, 'run-'));
	const reportPath = path.join(directory, 'report.json');
	const report = { renderer: 'MathJax 3.2.2 SVG', rendererUrl, before: path.resolve(values.before), markdown: path.resolve(values.markdown),
		formulas: corrected.length, changedFormulas: changed.length, reviewedEquation, onlyReviewedReplacements: true, obsidianDesktopVerified: false };
	let browser;
	try {
		const response = await fetch(rendererUrl, { signal: AbortSignal.timeout(30000) });
		if (!response.ok) throw new Error(`Renderer download failed: HTTP ${response.status}`);
		const renderer = await response.text();
		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext({ viewport: { width: 1200, height: 760 } });
		await context.route('**/*', route => route.abort());
		const page = await context.newPage();
		await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>body{background:#1e1e1e;color:#ddd;font:18px Arial;margin:36px}h1{font-size:24px}section{margin:24px 0;padding:20px 0;border-bottom:1px solid #555}p{font-size:14px}mjx-container{max-width:100%;overflow-x:auto}</style></head><body><h1>Frontiers: repaired formulas</h1><main></main></body></html>');
		await page.evaluate(() => { window.MathJax = { startup: { typeset: false }, options: { enableAssistiveMml: false }, tex: { packages: { '[-]': ['noundefined'] } }, svg: { fontCache: 'none' } }; });
		await page.addScriptTag({ content: renderer });
		await page.waitForFunction(() => window.MathJax?.startup?.document, { timeout: 30000 });
		const render = async (items, show) => page.evaluate(async ({ items, show }) => {
			await window.MathJax.startup.promise;
			const errors = [];
			let rendered = 0;
			for (const [index, item] of items.entries()) {
				const node = await window.MathJax.tex2svgPromise(item.tex, { display: item.display });
				const error = node.querySelector('[data-mjx-error], [data-mml-node="merror"]');
				if (error) errors.push({ index, message: error.getAttribute('data-mjx-error') || error.textContent });
				if (node.querySelector('svg path, svg use')) rendered++;
				if (show.includes(index)) {
					node.querySelector('mjx-assistive-mml')?.remove();
					const section = document.createElement('section');
					const label = document.createElement('p');
					label.textContent = `Formula ${index + 1}`;
					section.append(label, node);
					document.querySelector('main').append(section);
				}
			}
			return { rendered, errors };
		}, { items, show });
		report.original = await render(original, []);
		report.corrected = await render(corrected, changed);
		assert.equal(report.original.errors.length, changed.length, 'Original errors must correspond to the repaired formulas.');
		assert.deepEqual(report.original.errors.map(error => error.index), changed);
		assert.deepEqual(report.corrected.errors, []);
		assert.equal(report.corrected.rendered, corrected.length);
		report.screenshot = path.join(directory, 'repaired-formulas.png');
		await page.screenshot({ path: report.screenshot, fullPage: true });
		report.preview = path.join(directory, 'repaired-formulas.html');
		await page.evaluate(() => { document.querySelectorAll('script').forEach(script => script.remove()); });
		await writeFile(report.preview, await page.content(), { flag: 'wx' });
		report.status = 'passed';
	} catch (error) {
		report.status = 'failed';
		report.error = error.message;
	} finally { if (browser) await browser.close(); }
	await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
	console.log(JSON.stringify(report, null, 2));
	console.log(`Math acceptance report: ${reportPath}`);
	return report.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
