import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Marked } from 'marked';
import { parseHTML } from 'linkedom';
import { auditNatureLegends, compareWithoutAddedLegends } from './paper-captions.mjs';
import { stripFrontmatter } from './accept-papers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function main(args = process.argv.slice(2)) {
	const { values } = parseArgs({ args, options: { 'source-html': { type: 'string' }, markdown: { type: 'string' }, url: { type: 'string' }, before: { type: 'string' } } });
	if (!values['source-html'] || !values.markdown || !values.url) throw new Error('Usage: npm run accept:captions -- --source-html <capture.html> --markdown <note.md> --url <article-url> [--before <backup.md>]');
	const html = await readFile(path.resolve(values['source-html']), 'utf8');
	const markdown = await readFile(path.resolve(values.markdown), 'utf8');
	const audit = auditNatureLegends(html, markdown, values.url);
	assert.ok(audit.passed, JSON.stringify(audit.figures));
	if (values.before) {
		const before = await readFile(path.resolve(values.before), 'utf8');
		const reviewed = compareWithoutAddedLegends(html, markdown, before, values.url, audit.expected);
		assert.equal(reviewed.body, stripFrontmatter(before), 'Only source-backed legends may change in the note body.');
		assert.equal(markdown.slice(0, markdown.length - stripFrontmatter(markdown).length), before.slice(0, before.length - stripFrontmatter(before).length), 'Frontmatter must remain unchanged.');
	}
	const parent = path.join(root, 'output/playwright/paper-captions');
	await mkdir(parent, { recursive: true });
	const directory = await mkdtemp(path.join(parent, 'run-'));
	const report = { source: path.resolve(values['source-html']), markdown: path.resolve(values.markdown), before: values.before && path.resolve(values.before), figures: audit.figures, browserPaths: [], obsidianDesktopVerified: false };
	const bundle = await build({
		stdin: { contents: `import Defuddle from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';
import { prepareDocumentForExtraction } from './src/utils/publisher-figures';
import { parseForClip } from './src/utils/clip-utils';
window.checkCaptions = async (html, url, mode) => {
 const document = new DOMParser().parseFromString(html, 'text/html');
 Object.defineProperty(document, 'URL', { value: url });
 const original = document.documentElement.outerHTML;
 const parser = new Defuddle(prepareDocumentForExtraction(document, url), { url });
 const result = mode === 'save-markdown' ? parseForClip(document) : mode === 'async' ? await parser.parseAsync() : parser.parse();
 if (document.documentElement.outerHTML !== original) throw new Error('Live source document changed.');
 return createMarkdownContent(result.content, url);
};`, resolveDir: root, loader: 'ts' },
		bundle: true, write: false, format: 'iife', platform: 'browser', define: { DEBUG_MODE: 'false' },
		alias: { 'webextension-polyfill': path.join(root, 'src/utils/cli-stubs.ts'), 'defuddle/full': path.join(root, 'node_modules/defuddle/dist/index.full.js'), defuddle: path.join(root, 'node_modules/defuddle/dist/index.js') },
	});
	let browser;
	try {
		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
		await context.route('**/*', route => route.abort());
		const page = await context.newPage();
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		for (const mode of ['sync', 'async', 'save-markdown']) {
			const result = await page.evaluate(({ html, url, mode }) => window.checkCaptions(html, url, mode), { html, url: values.url, mode });
			const check = auditNatureLegends(html, result, values.url);
			await writeFile(path.join(directory, `${mode}.md`), result, { flag: 'wx' });
			report.browserPaths.push({ mode, passed: check.passed, figures: check.figures });
			assert.ok(check.passed, `${mode}: ${JSON.stringify(check.figures)}`);
		}
		const marked = new Marked();
		const note = parseHTML(`<html><body>${marked.parse(stripFrontmatter(markdown))}</body></html>`).document;
		const sections = [];
		for (const figure of audit.figures) {
			const title = [...note.querySelectorAll('p')].find(p => p.textContent === figure.title);
			const image = title?.previousElementSibling?.querySelector('img');
			assert.ok(image, `Missing image before ${figure.title}`);
			const relative = decodeURIComponent(image.getAttribute('src'));
			assert.ok(!/^[a-z]+:/i.test(relative) && !path.isAbsolute(relative), 'Preview requires local relative attachments.');
			const filename = path.resolve(path.dirname(values.markdown), relative);
			const data = await readFile(filename);
			const type = path.extname(filename).slice(1).replace('jpg', 'jpeg');
			image.setAttribute('src', `data:image/${type};base64,${data.toString('base64')}`);
			sections.push(`<section>${image.outerHTML}${title.outerHTML}${audit.blocks.filter(block => block.id === figure.id).map(block => marked.parse(block.raw)).join('')}</section>`);
		}
		const preview = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><style>body{background:#1e1e1e;color:#ddd;font:18px/1.65 Arial;margin:32px auto;max-width:1080px;padding:0 24px}img{display:block;max-width:100%;height:auto}section{margin-bottom:48px}a{color:#83c8f5}p{margin:22px 0}</style></head><body>' + sections.join('') + '</body></html>';
		await page.setContent(preview);
		await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
		report.preview = path.join(directory, 'novae-legends.html');
		report.screenshot = path.join(directory, 'figure-1.png');
		await writeFile(report.preview, preview, { flag: 'wx' });
		await page.locator('section').first().screenshot({ path: report.screenshot });
		report.status = 'passed';
	} catch (error) { report.status = 'failed'; report.error = error.message; }
	finally { if (browser) await browser.close(); }
	const reportPath = path.join(directory, 'report.json');
	await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
	console.log(JSON.stringify({ ...report, browserPaths: report.browserPaths.map(({ mode, passed }) => ({ mode, passed })), reportPath }, null, 2));
	return report.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
