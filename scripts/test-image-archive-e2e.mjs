import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
import { marked } from 'marked';
import { authorizedDownloadExtension, configureZipDownloads, openSavePage, readCompletedZip } from './fixtures/manual-save.mjs';
import { natureFiguresHtml, natureFiguresUrl } from './fixtures/nature-figures.mjs';

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
	await article.evaluate(() => {
		document.querySelector('figure').id = 'Fig1';
		for (const [name, content] of [['citation_doi', '10.1234/synthetic'], ['citation_publication_date', '2026-10-15']]) {
			const meta = document.createElement('meta');
			meta.name = name; meta.content = content; document.head.append(meta);
		}
	});
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
	assert.equal(download.fileName, '2026_Edited_synthetic_paper__10.1234_synthetic.zip');
	const zip = unzipSync(download.bytes);
	assert.equal(Object.keys(zip).length, 5);
	const metadata = JSON.parse(strFromU8(zip[Object.keys(zip).find(name => name.endsWith('/translation.json'))]));
	assert.equal(metadata.doi, '10.1234/synthetic');
	assert.equal(metadata.archiveStatus, 'complete');
	assert.equal(metadata.translationFile, 'paper.zh-CN.md');
	const checks = JSON.parse(strFromU8(zip[Object.keys(zip).find(name => name.endsWith('/checks.json'))]));
	assert.equal(checks.completeness, 'not-assessed');
	assert.equal(metadata.sourceVersion.value, checks.artifact.value);
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
		assert.match(name, /^2026_Edited_synthetic_paper__10\.1234_synthetic\/(?:paper\.md|checks\.json|translation\.json|images\/|images\/image-1\.png)$/);
		const target = path.join(extracted, name);
		if (name.endsWith('/')) { await mkdir(target, { recursive: true }); continue; }
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
	await popup.locator('#note-content-field').fill(`See [1b](${cellPage}#Fig1).\n\n![Figure](https://www.cell.com${smallPath})\n\nCaption.`);
	for (const fallback of [false, true]) {
		if (fallback) await context.route(`https://www.cell.com${largePath}`, route => route.fulfill({ status: 403, body: 'Denied' }));
		await popup.locator('#more-btn').click();
		const saving = await openSavePage(context, () => popup.locator('#save-image-archive').click());
		await reviewSaved(saving, fallback);
		const completed = await readCompletedZip(worker, saving, downloads);
		assert.notEqual(completed.fileName, download.fileName);
		const archive = unzipSync(completed.bytes);
		assert.match(strFromU8(archive[Object.keys(archive).find(name => name.endsWith('/paper.md'))]), /\[1b\]\(<images\/image-1\.png>\)/);
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
	// The reopened editor captured the caption whose paragraph structure was
	// replaced above, outside this check's scope. Missing coverage is not a warning.
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
	// The real popup must associate its responsive image with the source figure
	// ID and keep the comma outside italic labels before background ZIP export.
	await context.route(natureFiguresUrl, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: natureFiguresHtml }));
	await context.route('https://media.springernature.com/**', route => route.fulfill({ contentType: 'image/png', body: largePng }));
	await article.goto(natureFiguresUrl);
	await article.bringToFront();
	const natureOpening = context.waitForEvent('page');
	await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `${origin}/popup.html`);
	const naturePopup = await natureOpening;
	naturePopup.on('pageerror', error => errors.push(error.message));
	await naturePopup.waitForFunction(() => document.querySelector('#note-content-field')?.value.includes('GAMMA'));
	await naturePopup.locator('#more-btn').click();
	const natureSave = await openSavePage(context, () => naturePopup.locator('#save-image-archive').click());
	const natureDownload = await readCompletedZip(worker, natureSave, downloads);
	const natureZip = unzipSync(natureDownload.bytes);
	const natureRoot = natureDownload.fileName.slice(0, -4);
	const natureMd = strFromU8(natureZip[`${natureRoot}/paper.md`]);
	const natureChecks = JSON.parse(strFromU8(natureZip[`${natureRoot}/checks.json`]));
	assert.equal(natureChecks.preservation, 'passed-within-scope');
	assert.equal(natureChecks.stages.output.captions.matched, 1);
	assert.equal(natureChecks.images.downloaded, 2);
	assert.match(natureMd, /\[6b\]\(<images\/image-1.png>\)/);
	assert.match(natureMd, /\[1a\]\(<images\/image-2.png>\)/);
	assert.match(natureMd, /7, \*GAMMA\* \*n\* = 9/);
	const natureDirectory = path.join(directory, 'nature-offline');
	for (const [name, bytes] of Object.entries(natureZip)) {
		const target = path.join(natureDirectory, name);
		if (name.endsWith('/')) { await mkdir(target, { recursive: true }); continue; }
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, bytes);
	}
	const naturePreview = path.join(natureDirectory, natureRoot, 'preview.html');
	await writeFile(naturePreview, '<!doctype html><meta charset="utf-8"><title>Synthetic offline figure test</title><style>body{font:18px/1.7 sans-serif;max-width:900px;margin:40px auto;padding:0 20px}img{max-width:100%}</style>' + marked.parse(natureMd.replace(/^---\n[\s\S]*?\n---\n/, '')));
	const natureOffline = await context.newPage();
	await natureOffline.route('http://**', route => route.abort());
	await natureOffline.route('https://**', route => route.abort());
	await natureOffline.goto(pathToFileURL(naturePreview).href);
	await natureOffline.waitForFunction(() => [...document.images].length === 2 && [...document.images].every(img => img.complete && img.naturalWidth > 0));
	assert.equal(await natureOffline.locator('em').filter({ hasText: /^GAMMA$/ }).count(), 1);
	assert.doesNotMatch(await natureOffline.locator('body').innerText(), /\*/);
	await natureOffline.locator('p').filter({ hasText: 'Measured ALPHA' }).scrollIntoViewIfNeeded();
	await natureOffline.screenshot({ path: path.join(directory, 'nature-offline-caption.png') });
	for (const [label, file] of [['6b', 'image-1.png'], ['1a', 'image-2.png']]) {
		await natureOffline.getByRole('link', { name: label, exact: true }).click();
		await natureOffline.waitForURL(pathToFileURL(path.join(natureDirectory, natureRoot, 'images', file)).href);
		await natureOffline.waitForFunction(() => document.images[0]?.naturalWidth > 0);
		await natureOffline.goBack();
	}
	await natureOffline.close();
	await naturePopup.close();
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ passed: true, screenshots: directory, checks: ['real-menu-background-download', 'local-images', 'deduplication', 'editor-preserved', 'cell-high-resolution-128px', 'reported-original-fallback', 'popup-close-during-zip-save', 'no-activation-or-overwrite', 'failed-image-no-zip', 'safe-retry-after-popup-close', 'last-result-restored', 'mobile-layout', 'nature-caption-emphasis', 'responsive-and-extended-figure-local-navigation-offline'] }));
} finally { await context.close(); }
