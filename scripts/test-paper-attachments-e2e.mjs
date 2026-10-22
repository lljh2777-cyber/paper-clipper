import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
import { authorizedDownloadExtension, configureZipDownloads, openSavePage, readCompletedZip } from './fixtures/manual-save.mjs';

// Browser plugin not available. Run only in isolated hosted Chromium, never
// against personal browser sessions, publisher captures or local paper folders.
const directory = await mkdtemp(path.join(tmpdir(), 'paper-attachments-qa-'));
const extension = await authorizedDownloadExtension(directory);
const context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
	channel: 'chromium', headless: true, acceptDownloads: true,
	args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const source = 'https://journal.example.org/article';
const pdfUrl = 'https://files.example.org/supplement.pdf?Signature=synthetic-secret';
const csvUrl = 'https://files.example.org/table-s1.csv';
const pdf = '%PDF-1.4\nSynthetic supplementary methods';
const csv = 'sample,value\nA,10\nB,20\n';
const requests = [];
const errors = [];
let failPdf = true;
try {
	context.on('page', page => {
		page.on('pageerror', error => errors.push(error.message));
		page.on('console', message => {
			if (message.type() === 'error' && !message.text().includes('503 (Service Unavailable)')) errors.push(message.text());
		});
	});
	await context.route('https://raw.githubusercontent.com/**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));
	await context.route(source, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
		<title>Synthetic supplementary paper</title><meta name="citation_doi" content="10.1234/attachments">
		<meta name="citation_publication_date" content="2026-10-22"></head><body><article>
		<h1>Synthetic supplementary paper</h1><p>${'The synthetic measurements compare independent samples under controlled conditions. '.repeat(50)}</p>
		<p><a href="https://files.example.org/article.pdf">Download PDF</a></p>
		<h2>Supplementary information</h2><p>The methods and tabular measurements are available in
		<a href="${pdfUrl}">Supplementary methods and experimental protocol</a> and
		<a href="${csvUrl}">Supplementary Table S1: measurements</a>.</p>
		</article></body></html>` }));
	await context.route('https://files.example.org/**', route => {
		const url = route.request().url(); requests.push(url);
		assert.equal(route.request().headers().cookie, undefined);
		if (url === pdfUrl) return route.fulfill(failPdf ? { status: 503, body: 'Synthetic retryable outage' } : { contentType: 'application/pdf', body: pdf });
		if (url === csvUrl) return route.fulfill({ contentType: 'text/csv', body: csv });
		throw new Error('An unselected file was requested');
	});
	const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
	const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
	await worker.evaluate(() => chrome.storage.local.set({ language: 'en' }));
	const article = await context.newPage();
	const downloads = await configureZipDownloads(context, article, directory);
	await article.goto(source);
	const opening = context.waitForEvent('page');
	await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `${origin}/popup.html`);
	const popup = await opening;
	await popup.waitForURL(`${origin}/popup.html`);
	assert.equal(popup.url(), `${origin}/popup.html`);
	await popup.waitForFunction(() => document.querySelector('#note-content-field')?.value.includes('synthetic measurements'));
	await popup.locator('#paper-attachments summary').waitFor();
	assert.equal(await popup.locator('#paper-attachments input').count(), 2);
	assert.equal(await popup.locator('#paper-attachments input:checked').count(), 0);
	assert.deepEqual(requests, []);
	await popup.locator('#more-btn').click();
	const noSelection = await openSavePage(context, () => popup.locator('#save-image-archive').click());
	const first = await readCompletedZip(worker, noSelection, downloads);
	const firstZip = unzipSync(first.bytes);
	assert.equal(Object.keys(firstZip).some(name => /supplement/.test(name)), false);
	assert.deepEqual(requests, []);

	await popup.locator('#paper-attachments summary').click();
	await popup.locator('#paper-attachments input').nth(0).check();
	await popup.locator('#paper-attachments input').nth(1).check();
	assert.match(await popup.locator('#paper-attachments summary').innerText(), /2 \/ 2 selected/);
	for (const [width, height] of [[1280, 900], [390, 844]]) {
		await popup.setViewportSize({ width, height });
		assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		assert.equal(await popup.locator('#paper-attachments input').nth(1).isVisible(), true);
		await popup.screenshot({ path: path.join(directory, `attachments-${width}.png`) });
	}
	await popup.locator('#more-btn').click();
	const failed = await openSavePage(context, () => popup.locator('#save-image-archive').click());
	await failed.page.locator('#retry-save').waitFor({ state: 'visible' });
	assert.match(await failed.page.locator('#save-status').innerText(), /supplementary file 1 could not be downloaded/);
	assert.match(await failed.page.locator('#save-status').innerText(), /No archive was published/);
	assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), 1);
	assert.deepEqual(requests, [pdfUrl]);
	await popup.close();
	failPdf = false;
	await failed.page.locator('#retry-save').click();
	const completed = await readCompletedZip(worker, failed, downloads);
	assert.notEqual(completed.fileName, first.fileName);
	assert.deepEqual(requests, [pdfUrl, pdfUrl, csvUrl]);
	const zip = unzipSync(completed.bytes);
	const root = Object.keys(zip)[0].split('/')[0];
	assert.equal(root, '2026_Synthetic_supplementary_paper__10.1234_attachments');
	const receiptText = strFromU8(zip[`${root}/supplement-report.json`]);
	assert.equal(receiptText.includes('synthetic-secret'), false);
	const receipt = JSON.parse(receiptText);
	assert.equal(receipt.contentSafety, 'not-assessed');
	assert.equal(receipt.items.length, 2);
	for (const [index, item] of receipt.items.entries()) {
		assert.equal(strFromU8(zip[`${root}/${item.file}`]), index === 0 ? pdf : csv);
		assert.equal(item.sha256, createHash('sha256').update(zip[`${root}/${item.file}`]).digest('hex'));
	}
	const md = strFromU8(zip[`${root}/paper.md`]);
	assert.match(md, /\]\(<supplements\/attachment-1-supplement\.pdf>\)/);
	assert.match(md, /\]\(<supplements\/attachment-2-table-s1\.csv>\)/);
	assert.match(md, /https:\/\/files\.example\.org\/article\.pdf/);
	const checks = JSON.parse(strFromU8(zip[`${root}/checks.json`]));
	const metadata = JSON.parse(strFromU8(zip[`${root}/translation.json`]));
	assert.equal(checks.attachments.downloaded, 2);
	assert.equal(checks.artifact.value, createHash('sha256').update(md).digest('hex'));
	assert.equal(metadata.sourceVersion.value, checks.artifact.value);
	assert.equal(metadata.acquisition.attachments, 2);
	assert.equal(metadata.archiveStatus, 'complete');
	assert.equal(await worker.evaluate(async () => (await chrome.storage.session.get('paperSaveLastResult')).paperSaveLastResult.state), 'saved');
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ passed: true, screenshots: directory, checks: ['unchecked-no-fetch', 'selected-only', 'responsive-picker', 'no-partial-zip', 'retry-after-popup-close', 'local-links', 'receipt-and-hashes', 'existing-download-not-replaced'] }));
} finally { await context.close(); }
