import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { parseHTML } from 'linkedom';
import { unzipSync, strFromU8 } from 'fflate';
import temml from 'temml';
import { marked } from 'marked';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { mathHtml } from './fixtures/mathjax.mjs';
import { runtimeMathHtml, installSyntheticMathJax } from './fixtures/mathjax-runtime.mjs';
import { pmcHtml, pmcUrl } from './fixtures/pmc.mjs';
import { cellAuthorYearHtml, cellAuthorYearUrl } from './fixtures/cell-author-year.mjs';
import { checkMathPreservation, mathInventory } from '../src/utils/paper-math.mjs';
import { authorizedDownloadExtension, configureZipDownloads, openSavePage, readCompletedZip } from './fixtures/manual-save.mjs';

// Browser plugin not available. Only a fresh, isolated Chromium profile is used.
// Flow: synthetic page -> actual extension popup -> ZIP -> rendered formulas.
const directory = await mkdtemp(path.join(tmpdir(), 'paper-math-qa-'));
const extension = await authorizedDownloadExtension(directory);
const server = createServer((request, response) => {
	response.setHeader('Content-Type', 'text/html; charset=utf-8');
	response.end(request.url === '/lazy' ? runtimeMathHtml.replace('</body>', `<script>(${installSyntheticMathJax.toString()})();</script></body>`) : mathHtml);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/synthetic-math`;
const context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
	channel: 'chromium', headless: true, acceptDownloads: true,
	args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
	await context.route('https://**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));
	await context.route(pmcUrl, route => route.fulfill({ contentType: 'text/html', body: pmcHtml }));
	await context.route(cellAuthorYearUrl, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: cellAuthorYearHtml }));
	await context.route(/^https:\/\/images\.example\.org\/(?:math-figure|figure)\.png$/, route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=', 'base64') }));
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
	const consoleErrors = [];
	const observeConsole = page => page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	observeConsole(article);
	observeConsole(popup);
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
	await article.evaluate(() => {
		document.querySelector('mjx-math').innerHTML = '<mjx-msqrt></mjx-msqrt>';
		const extra = document.createElement('p');
		extra.innerHTML = '<mjx-container><mjx-lazy></mjx-lazy></mjx-container>'.repeat(100);
		document.querySelector('article').append(extra);
	});
	await popup.close();
	await article.bringToFront();
	const opening = context.waitForEvent('page');
	await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `${origin}/popup.html`);
	const rejected = await opening;
	observeConsole(rejected);
	await rejected.locator('.error-message').filter({ hasText: 'formula(s) could not be safely converted' }).waitFor();
	assert.match(await rejected.locator('.error-message').textContent(), /101 formula/);
	assert.ok((await rejected.locator('.error-message').textContent()).length < 200);
	for (const [label, width, height] of [['desktop', 1100, 900], ['mobile', 390, 844]]) {
		await rejected.setViewportSize({ width, height });
		const bounds = await rejected.locator('.error-message').boundingBox();
		assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= height);
		await rejected.screenshot({ path: path.join(directory, `error-${label}.png`) });
	}
	await rejected.close();
	await article.goto(new URL('/lazy', url).href);
	await article.bringToFront();
	assert.equal(await article.locator('mjx-lazy').count(), 5);
	assert.equal(await article.locator('[data-paper-mathml], mjx-container[data-latex]').count(), 0);
	const lazyOpening = context.waitForEvent('page');
	await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `${origin}/popup.html`);
	const lazyPopup = await lazyOpening;
	observeConsole(lazyPopup);
	lazyPopup.on('pageerror', error => errors.push(error.message));
	await lazyPopup.waitForFunction(() => document.querySelector('#note-content-field')?.value.includes('bold caption text'));
	assert.equal(checkMathPreservation(parseHTML(runtimeMathHtml).document, await lazyPopup.locator('#note-content-field').inputValue()).matched, 5);
	assert.equal(await article.locator('[data-paper-mathml], mjx-container[data-latex]').count(), 0);
	await lazyPopup.locator('#more-btn').click();
	const lazySave = await openSavePage(context, () => lazyPopup.locator('#save-image-archive').click());
	const lazyArchive = unzipSync((await readCompletedZip(worker, lazySave, downloads)).bytes);
	const lazyChecks = JSON.parse(strFromU8(lazyArchive[Object.keys(lazyArchive).find(key => key.endsWith('/checks.json'))]));
	for (const stage of ['extraction', 'template', 'output']) assert.equal(lazyChecks.stages[stage].math.matched, 5);
	const lazySaved = strFromU8(lazyArchive[Object.keys(lazyArchive).find(key => key.endsWith('/paper.md'))]);
	assert.equal(checkMathPreservation(parseHTML(runtimeMathHtml).document, lazySaved).matched, 5);
	assert.doesNotMatch(lazySaved, /No alternative text available/);
	const lazyFormulas = Array.from(lazySaved.matchAll(/\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$/g), match => ({ latex: match[1] ?? match[2], block: match[1] !== undefined }));
	await preview.setContent('<!doctype html><title>Lazy formula preview</title><style>body{font:18px Georgia;margin:24px}section{margin:24px 0}</style><h1>Retained formula input</h1>' + lazyFormulas.map(item =>
		`<section>${temml.renderToString(item.latex, { displayMode: item.block, throwOnError: true })}</section>`).join(''));
	assert.equal(await preview.locator('math').count(), 5);
	assert.equal(await preview.locator('merror').count(), 0);
	await preview.screenshot({ path: path.join(directory, 'formulas-lazy.png'), fullPage: true });
	// Use the real publisher URL but fulfill it only with the synthetic fixture.
	await lazyPopup.close();
	await article.goto(pmcUrl);
	await article.bringToFront();
	const pmcOpening = context.waitForEvent('page');
	await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `${origin}/popup.html`);
	const pmcPopup = await pmcOpening;
	observeConsole(pmcPopup);
	pmcPopup.on('pageerror', error => errors.push(error.message));
	await pmcPopup.waitForFunction(() => document.querySelector('#note-content-field')?.value.includes('Figure 1. Synthetic experimental workflow.'));
	const pmcMarkdown = await pmcPopup.locator('#note-content-field').inputValue();
	assert.equal(pmcMarkdown.split('Figure 1. Synthetic experimental workflow.').length, 2);
	assert.doesNotMatch(pmcMarkdown, /\/author\/|Find articles by|Open in a new tab/);
	assert.match(pmcMarkdown, /Ada Example is also mentioned/);
	assert.equal(await article.locator('.cg').count(), 1);
	assert.equal(await article.locator('figure > .obj_head').count(), 1);
	await pmcPopup.locator('#more-btn').click();
	const pmcSave = await openSavePage(context, () => pmcPopup.locator('#save-image-archive').click());
	const pmcArchive = unzipSync((await readCompletedZip(worker, pmcSave, downloads)).bytes);
	const pmcSaved = strFromU8(pmcArchive[Object.keys(pmcArchive).find(key => key.endsWith('/paper.md'))]);
	assert.equal(pmcSaved.split('Figure 1. Synthetic experimental workflow.').length, 2);
	const savedImages = fromMarkdown(pmcSaved).children.flatMap(block => block.children ?? []).filter(node => node.type === 'image');
	assert.equal(savedImages.length, 1);
	assert.equal(savedImages[0].alt, 'Figure 1.');
	assert.match(savedImages[0].url, /^images\//);
	assert.match(pmcSaved, /Ada Example/); // Metadata/body mentions survive.
	assert.doesNotMatch(pmcSaved, /\/author\/|Find articles by/);
	// Show the relevant exported passage, without the long synthetic prose.
	const imagePath = savedImages[0].url;
	const imageKey = Object.keys(pmcArchive).find(key => key.endsWith(`/${imagePath}`));
	const passage = pmcSaved.slice(pmcSaved.indexOf('Figure 1. Synthetic experimental workflow.'), pmcSaved.indexOf('After figure marker.'))
		.replace(imagePath, `data:image/png;base64,${Buffer.from(pmcArchive[imageKey]).toString('base64')}`);
	await preview.setContent('<!doctype html><title>PMC exported figure</title><style>body{font:18px Georgia;margin:24px;line-height:1.6}img{width:240px;height:100px;background:#e0f0ed}</style>' + marked.parse(passage));
	for (const [label, width, height] of [['desktop', 1100, 900], ['mobile', 390, 844]]) {
		await preview.setViewportSize({ width, height });
		assert.equal(await preview.locator('p').filter({ hasText: 'Figure 1. Synthetic experimental workflow.' }).count(), 1);
		assert.equal(await preview.locator('sub').textContent(), '2');
		assert.equal(await preview.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		await preview.screenshot({ path: path.join(directory, `pmc-${label}.png`) });
	}
	await pmcPopup.close();
	await article.goto(cellAuthorYearUrl);
	await article.bringToFront();
	assert.equal(await article.title(), 'Synthetic author-year citations');
	assert.equal(await article.evaluate(() => document.characterSet), 'UTF-8');
	assert.equal(await article.locator('#body-ref-a').textContent(), 'Núñez et al., 2024');
	const cellOpening = context.waitForEvent('page');
	await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `${origin}/popup.html`);
	const cellPopup = await cellOpening;
	observeConsole(cellPopup);
	cellPopup.on('pageerror', error => errors.push(error.message));
	try {
		await cellPopup.waitForFunction(() => document.querySelector('#note-content-field')?.value.includes('Núñez et al., 2024'));
	} catch (error) {
		await cellPopup.screenshot({ path: path.join(directory, 'cell-extraction-error.png') });
		console.error(JSON.stringify({ errors, consoleErrors, popup: (await cellPopup.locator('body').innerText()).slice(0, 1500),
			markdown: await cellPopup.locator('#note-content-field').inputValue().catch(() => null) }));
		throw error;
	}
	const cellMarkdown = await cellPopup.locator('#note-content-field').inputValue();
	assert.doesNotMatch(cellMarkdown, /Preview-only|Hidden reference preview/);
	assert.match(cellMarkdown, /Núñez et al\., 2024\s*\[\^1\]/);
	assert.equal(await article.locator('.reference-citations').count(), 6);
	await cellPopup.locator('#more-btn').click();
	const cellSave = await openSavePage(context, () => cellPopup.locator('#save-image-archive').click());
	const cellArchive = unzipSync((await readCompletedZip(worker, cellSave, downloads)).bytes);
	const cellChecks = JSON.parse(strFromU8(cellArchive[Object.keys(cellArchive).find(key => key.endsWith('/checks.json'))]));
	for (const stage of ['extraction', 'template', 'output']) {
		assert.equal(cellChecks.stages[stage].references.matched, 2);
		assert.equal(cellChecks.stages[stage].references.status, 'passed');
		assert.equal(cellChecks.stages[stage].captions.matched, 2);
		assert.equal(cellChecks.stages[stage].captions.status, 'passed');
	}
	assert.equal(cellChecks.preservation, 'passed-within-scope');
	assert.equal(cellChecks.completeness, 'not-assessed');
	const cellSaved = strFromU8(cellArchive[Object.keys(cellArchive).find(key => key.endsWith('/paper.md'))]);
	assert.match(cellSaved, /Chen, 2025 <sup><a href="#fn:2">2<\/a><\/sup>/);
	assert.equal((cellSaved.match(/^\[\^\d+\]:/gm) ?? []).length, 2);
	await cellPopup.locator('#image-archive-status').filter({ hasText: 'ZIP saved:' }).waitFor();
	assert.equal(await worker.evaluate(async () => (await chrome.storage.session.get('paperSaveLastResult')).paperSaveLastResult.state), 'saved');
	for (const [label, width, height] of [['desktop', 1100, 900], ['mobile', 390, 844]]) {
		await cellPopup.setViewportSize({ width, height });
		assert.equal(await cellPopup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		await cellPopup.screenshot({ path: path.join(directory, `cell-author-year-${label}.png`) });
	}
	assert.deepEqual(errors, []);
	assert.deepEqual(consoleErrors, []);
	console.log(JSON.stringify({ passed: true, directory, sourceFormulas: mathInventory(source).length,
		checks: ['extension-popup', 'zip-roundtrip', 'tex-rendering', 'matrix-rows-and-columns', 'desktop-and-mobile', 'no-runtime-errors', 'unsupported-error-visible', 'main-world-lazy-source', 'caption-occurrences', 'numbered-equations', 'pmc-metadata-and-figure-title'] }));
} finally {
	await context.close();
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
}
