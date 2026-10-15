import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { parseHTML } from 'linkedom';
import { unzipSync, strFromU8 } from 'fflate';
import temml from 'temml';
import { mathHtml } from './fixtures/mathjax.mjs';
import { checkMathPreservation, mathInventory } from '../src/utils/paper-math.mjs';
import { authorizedDownloadExtension, configureZipDownloads, openSavePage, readCompletedZip } from './fixtures/manual-save.mjs';

// Browser plugin not available. Only a fresh, isolated Chromium profile is used.
// Flow: synthetic page -> actual extension popup -> ZIP -> rendered formulas.
const directory = await mkdtemp(path.join(tmpdir(), 'paper-math-qa-'));
const extension = await authorizedDownloadExtension(directory);
const server = createServer((request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(mathHtml); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/synthetic-math`;
const context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
	channel: 'chromium', headless: true, acceptDownloads: true,
	args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
	await context.route('https://**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));
	const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
	const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
	await worker.evaluate(() => chrome.storage.local.set({ language: 'en' }));
	const article = await context.newPage();
	const downloads = await configureZipDownloads(context, article, directory);
	await article.goto(url);
	assert.equal(await article.title(), 'Synthetic math preservation');
	const next = context.waitForEvent('page');
	await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `${origin}/popup.html`);
	const popup = await next;
	const errors = [];
	popup.on('pageerror', error => errors.push(error.message));
	await popup.waitForFunction(() => document.querySelector('#note-content-field')?.value.includes('The spaced matrix is:'));
	const markdown = await popup.locator('#note-content-field').inputValue();
	const source = parseHTML(mathHtml).document;
	assert.equal(checkMathPreservation(source, markdown).matched, 8);
	await popup.locator('#more-btn').click();
	const save = await openSavePage(context, () => popup.locator('#save-image-archive').click());
	const archive = unzipSync((await readCompletedZip(worker, save, downloads)).bytes);
	const checks = JSON.parse(strFromU8(archive[Object.keys(archive).find(key => key.endsWith('/checks.json'))]));
	for (const stage of ['extraction', 'template', 'output']) assert.deepEqual(
		{ status: checks.stages[stage].math.status, expected: checks.stages[stage].math.expected, matched: checks.stages[stage].math.matched },
		{ status: 'passed', expected: 8, matched: 8 });
	const saved = strFromU8(archive[Object.keys(archive).find(key => key.endsWith('/paper.md'))]);
	assert.equal(checkMathPreservation(source, saved).status, 'passed');
	const formulas = Array.from(saved.matchAll(/\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$/g), match => ({ latex: match[1] ?? match[2], block: match[1] !== undefined }));
	assert.equal(formulas.length, 8);
	const preview = await context.newPage();
	preview.on('pageerror', error => errors.push(error.message));
	await preview.setContent('<!doctype html><title>Synthetic formula preview</title><style>body{font:18px Georgia;margin:24px;line-height:1.6}section{margin:16px 0}math{max-width:100%}</style><h1>Synthetic formula preview</h1>' + formulas.map((item, index) =>
		`<section>Formula ${index + 1}: ${temml.renderToString(item.latex, { displayMode: item.block, throwOnError: true })}</section>`).join(''));
	for (const [label, width, height] of [['desktop', 1100, 900], ['mobile', 390, 844]]) {
		await preview.setViewportSize({ width, height });
		assert.equal(await preview.locator('math').count(), 8);
		assert.equal(await preview.locator('merror').count(), 0);
		assert.ok(await preview.locator('math').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0)));
		assert.equal(await preview.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		await preview.screenshot({ path: path.join(directory, `formulas-${label}.png`), fullPage: true });
	}
	const matrixRows = await preview.locator('section').nth(3).locator('mtr').evaluateAll(rows => rows.map(row => row.querySelectorAll('mtd').length));
	assert.deepEqual(matrixRows, [3, 3]);
	assert.ok((await preview.locator('section').nth(0).textContent()).includes('\u{1D499}'));
	assert.deepEqual(errors, []);
	// A recognized but unsupported source must show its formula error, not a
	// misleading extension-startup error or a successful incomplete note.
	await article.evaluate(() => document.querySelector('mjx-math').innerHTML = '<mjx-msqrt></mjx-msqrt>');
	await popup.close();
	await article.bringToFront();
	const opening = context.waitForEvent('page');
	await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `${origin}/popup.html`);
	const rejected = await opening;
	await rejected.locator('.error-message').filter({ hasText: 'formula(s) could not be safely converted' }).waitFor();
	console.log(JSON.stringify({ passed: true, directory, sourceFormulas: mathInventory(source).length,
		checks: ['extension-popup', 'zip-roundtrip', 'tex-rendering', 'matrix-rows-and-columns', 'desktop-and-mobile', 'no-runtime-errors', 'unsupported-error-visible'] }));
} finally {
	await context.close();
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
}
