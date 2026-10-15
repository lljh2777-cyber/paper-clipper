import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
import { marked } from 'marked';
import { authorizedDownloadExtension, configureZipDownloads, openSavePage, readCompletedZip } from './fixtures/manual-save.mjs';

// Browser plugin not available: exercise the built extension in isolated Playwright.
const directory = await mkdtemp(path.join(tmpdir(), 'paper-image-zip-qa-'));
const extension = await authorizedDownloadExtension(directory);
const context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
	channel: 'chromium', headless: true, acceptDownloads: true,
	args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=', 'base64');
const largePng = await readFile(new URL('../src/icons/icon128.png', import.meta.url));
const smallPath = '/cms/10.1234/test/asset/preview/main.assets/gr1.png';
const largePath = '/cms/10.1234/test/asset/different/main.assets/gr1_lrg.png';
const cellPage = 'https://www.cell.com/cell/fulltext/synthetic-images';
try {
	await context.route('https://raw.githubusercontent.com/**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));
	await context.route(cellPage, route => route.fulfill({ contentType: 'text/html', body: '<html><head><title>Synthetic paper</title></head><body><article><h1>Synthetic paper</h1><p>' + 'Synthetic paper body. '.repeat(100) + `</p><figure class="graphic"><img src="https://www.cell.com${smallPath}" data-viewer-src="${largePath}"><figcaption><div class="figure__title">Synthetic figure.</div><div class="accordion" hidden><div class="figure__caption__text__content"><p>Synthetic captured caption describing the experimental measurements.</p></div></div></figcaption></figure></article></body></html>` }));
	await context.route(`https://www.cell.com${smallPath}`, route => route.fulfill({ contentType: 'image/png', body: png }));
	await context.route(`https://www.cell.com${largePath}`, route => route.fulfill({ contentType: 'image/png', body: largePng }));
	await context.route('https://images.example.org/**', route => route.fulfill({ contentType: 'image/png', body: png }));
	const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
	const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
	await worker.evaluate(() => chrome.storage.local.set({ language: 'en' }));
	const article = await context.newPage();
	const downloads = await configureZipDownloads(context, article, directory);
	await article.goto(cellPage);
	const next = context.waitForEvent('page');
	await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `${origin}/popup.html`);
	let popup = await next;
	const errors = [];
	const reviewSaved = async (save, fallback = false) => {
		save.page.on('pageerror', error => errors.push(error.message));
		await save.page.locator('#save-status[data-warning="true"]').waitFor();
		await save.page.waitForFunction(async () => (await chrome.tabs.getCurrent()).active && (await chrome.storage.session.get('paperSaveLastResult')).paperSaveLastResult?.id === location.hash.slice(1));
		assert.equal(await save.page.evaluate(async () => (await chrome.tabs.getCurrent()).active), true);
		assert.match(await save.page.locator('#save-status').innerText(), /Saved, but review is needed/);
		assert.equal(await save.page.locator('#retry-save').isVisible(), false);
		if (fallback) assert.match(await save.page.locator('#save-status').innerText(), /fell back to the original page image/);
		assert.equal(await worker.evaluate(async () => (await chrome.storage.session.get('paperSaveLastResult')).paperSaveLastResult.state), 'saved-warning');
		await save.page.locator('#close-save').click();
	};
	popup.on('pageerror', error => errors.push(error.message));
	await popup.locator('#note-content-field').waitFor({ state: 'visible' });
	await popup.locator('#save-image-archive').waitFor({ state: 'attached' });
	await popup.waitForFunction(() => document.querySelector('#note-content-field')?.value.includes('Synthetic paper body.'));
	assert.match(await popup.locator('#note-content-field').inputValue(), /Synthetic captured caption/);
	// Changing the live source after extraction must not change the report's baseline.
	await article.evaluate(() => { document.querySelector('.figure__caption__text__content').textContent = 'Changed after capture.'; });
	await popup.locator('#note-name-field').fill('Edited synthetic paper');
	const markdown = '# Edited paper\n\n![Panel A](https://images.example.org/a.png?Expires=42&Signature=test)\n\nFigure 1. Preserved caption.\n\n![Panel B](https://images.example.org/a.png?Expires=42&Signature=test)';
	await popup.locator('#note-content-field').fill(markdown);
	await popup.setViewportSize({ width: 1100, height: 900 });
	await popup.locator('#more-btn').click();
	await popup.screenshot({ path: path.join(directory, 'menu-desktop.png') });
	const save = await openSavePage(context, () => popup.locator('#save-image-archive').click());
	await save.page.locator('#save-status[data-warning="true"]').waitFor();
	assert.match(await save.page.locator('#save-status').innerText(), /Edited output \/ Figure captions/);
	assert.match(await save.page.locator('#save-status').innerText(), /they do not by themselves prove a conversion error/);
	for (const [width, height] of [[1280, 900], [390, 844]]) {
		await save.page.setViewportSize({ width, height });
		assert.equal(await save.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		await save.page.screenshot({ path: path.join(directory, `review-${width}.png`) });
	}
	await reviewSaved(save);
	const download = await readCompletedZip(worker, save, downloads);
	assert.equal(download.fileName, 'paper-Edited synthetic paper.zip');
	const zip = unzipSync(download.bytes);
	assert.equal(Object.keys(zip).length, 3);
	const checks = JSON.parse(strFromU8(zip[Object.keys(zip).find(name => name.endsWith('/checks.json'))]));
	assert.equal(checks.completeness, 'not-assessed');
	assert.equal(checks.changes.editor, 'changed');
	assert.equal(checks.images.downloaded, 1);
	assert.equal(checks.stages.extraction.captions.status, 'passed');
	assert.equal(checks.stages.output.captions.status, 'failed');
	assert.equal(checks.preservation, 'attention-required');
	const md = strFromU8(zip[Object.keys(zip).find(name => name.endsWith('/paper.md'))]);
	assert.match(md, /# Edited paper/);
	assert.match(md, /Figure 1\. Preserved caption\./);
	assert.equal(md.match(/images\/image-1.png/g)?.length, 2);
	const extracted = path.join(directory, 'extracted');
	for (const [name, bytes] of Object.entries(zip)) {
		assert.match(name, /^paper-[0-9a-f-]+\/(?:paper.md|checks.json|images\/image-1.png)$/);
		const target = path.join(extracted, name);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, bytes);
	}
	const rendered = path.join(extracted, Object.keys(zip)[0].split('/')[0], 'preview.html');
	await writeFile(rendered, '<!doctype html><title>Offline archive</title>' + marked.parse(md.replace(/^---\n[\s\S]*?\n---\n/, '')));
	const offline = await context.newPage();
	await offline.route('http://**', route => route.abort());
	await offline.route('https://**', route => route.abort());
	await offline.goto(pathToFileURL(rendered).href);
	await offline.waitForFunction(() => [...document.images].length === 2 && [...document.images].every(img => img.complete && img.naturalWidth === 1));
	await offline.close();
	assert.equal(await popup.locator('#note-content-field').inputValue(), markdown);
	await popup.locator('#image-archive-status').filter({ hasText: 'ZIP saved:' }).waitFor();
	assert.match(await popup.locator('#image-archive-status').textContent(), /Content differences found/);
	await popup.setViewportSize({ width: 390, height: 844 });
	await popup.screenshot({ path: path.join(directory, 'saved-mobile.png') });
	assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	// The original page, not an invented filename, supplies Cell's different asset ID.
	await popup.locator('#note-content-field').fill(`![Figure](https://www.cell.com${smallPath})\n\nCaption.`);
	for (const fallback of [false, true]) {
		if (fallback) await context.route(`https://www.cell.com${largePath}`, route => route.fulfill({ status: 403, body: 'Denied' }));
		await popup.locator('#more-btn').click();
		const saving = await openSavePage(context, () => popup.locator('#save-image-archive').click());
		await reviewSaved(saving, fallback);
		const completed = await readCompletedZip(worker, saving, downloads);
		assert.notEqual(completed.fileName, download.fileName);
		const archive = unzipSync(completed.bytes);
		const image = archive[Object.keys(archive).find(name => name.endsWith('/images/image-1.png'))];
		const report = JSON.parse(strFromU8(archive[Object.keys(archive).find(name => name.endsWith('/image-report.json'))]));
		assert.equal(report.items[0].selection, fallback ? 'original-fallback' : 'preferred');
		assert.deepEqual(Buffer.from(image), fallback ? png : largePng);
		if (!fallback) {
			const dimensions = await popup.evaluate(async bytes => {
				const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
				const size = [image.width, image.height]; image.close(); return size;
			}, [...image]);
			assert.deepEqual(dimensions, [128, 128]);
		}
	}
	// A normal popup may disappear while assets are still being fetched. Its
	// independent save must finish without activating the save tab or overwriting.
	let releaseImage;
	const heldImage = new Promise(resolve => { releaseImage = resolve; });
	await context.route('https://images.example.org/held.png', async route => {
		await heldImage;
		await route.fulfill({ contentType: 'image/png', body: png });
	});
	await popup.locator('#note-content-field').fill('![Held](https://images.example.org/held.png)');
	await popup.locator('#more-btn').click();
	const independent = await openSavePage(context, () => popup.locator('#save-image-archive').click());
	await independent.page.locator('#save-status').filter({ hasText: 'Downloading images:' }).waitFor();
	assert.equal(await independent.page.evaluate(async () => (await chrome.tabs.getCurrent()).active), false);
	await popup.close();
	releaseImage();
	await reviewSaved(independent);
	await readCompletedZip(worker, independent, downloads);
	assert.deepEqual(await readFile(path.join(downloads, download.fileName)), download.bytes);
	await article.bringToFront();
	const openingAgain = context.waitForEvent('page');
	await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `${origin}/popup.html`);
	popup = await openingAgain;
	popup.on('pageerror', error => errors.push(error.message));
	await popup.waitForFunction(() => document.querySelector('#note-content-field')?.value.includes('Synthetic paper body.'));
	// Exercise a failed retry through the same control: no partial download or editor loss.
	await context.route('https://images.example.org/bad.png', route => route.fulfill({ status: 403, body: 'Not authorized' }));
	const failedNote = '![x](https://images.example.org/bad.png)';
	await popup.locator('#note-content-field').fill(failedNote);
	const beforeFailure = await worker.evaluate(async () => (await chrome.downloads.search({})).length);
	await popup.locator('#more-btn').click();
	const failed = await openSavePage(context, () => popup.locator('#save-image-archive').click());
	await failed.page.locator('#retry-save').waitFor({ state: 'visible' });
	await popup.locator('#image-archive-status').filter({ hasText: 'No output folder or ZIP was created' }).waitFor();
	assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), beforeFailure);
	assert.equal(await popup.locator('#note-content-field').inputValue(), failedNote);
	await failed.page.setViewportSize({ width: 390, height: 844 });
	assert.equal(await failed.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await failed.page.screenshot({ path: path.join(directory, 'failed-mobile.png') });
	// Close the originating popup, then retry the same snapshot after recovery.
	await popup.close();
	await context.route('https://images.example.org/bad.png', route => route.fulfill({ contentType: 'image/png', body: png }));
	await failed.page.locator('#retry-save').click();
	// The reopened editor captured the deliberately shortened caption above,
	// outside the caption check's scope. Missing coverage is not a warning.
	const retried = await readCompletedZip(worker, failed, downloads);
	assert.equal(await worker.evaluate(async () => (await chrome.storage.session.get('paperSaveLastResult')).paperSaveLastResult.state), 'saved');
	const retryZip = unzipSync(retried.bytes);
	const retryImages = [];
	marked.walkTokens(marked.lexer(strFromU8(retryZip[Object.keys(retryZip).find(name => name.endsWith('/paper.md'))])), token => {
		if (token.type === 'image') retryImages.push({ text: token.text, href: token.href });
	});
	assert.deepEqual(retryImages, [{ text: 'x', href: 'images/image-1.png' }]);
	assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), beforeFailure + 1);
	// Reopening the editor restores terminal feedback without persisting a manuscript.
	await article.bringToFront();
	const reopening = context.waitForEvent('page');
	await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `${origin}/popup.html`);
	const reopened = await reopening;
	await reopened.locator('#image-archive-status').filter({ hasText: 'Last save result: ZIP saved:' }).waitFor();
	await reopened.close();
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ passed: true, screenshots: directory, checks: ['real-menu-background-download', 'local-images', 'deduplication', 'editor-preserved', 'cell-high-resolution-128px', 'reported-original-fallback', 'popup-close-during-zip-save', 'no-activation-or-overwrite', 'failed-image-no-zip', 'safe-retry-after-popup-close', 'last-result-restored', 'mobile-layout'] }));
} finally { await context.close(); }
