import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
import { marked } from 'marked';

// Browser plugin not available: exercise the built extension in isolated Playwright.
const directory = await mkdtemp(path.join(tmpdir(), 'paper-image-zip-qa-'));
const extension = fileURLToPath(new URL('../dev', import.meta.url));
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
	await context.route(cellPage, route => route.fulfill({ contentType: 'text/html', body: '<html><head><title>Synthetic paper</title></head><body><article><h1>Synthetic paper</h1><p>' + 'Synthetic paper body. '.repeat(100) + `</p><figure><img src="https://www.cell.com${smallPath}" data-viewer-src="${largePath}"><figcaption>Synthetic figure.</figcaption></figure></article></body></html>` }));
	await context.route(`https://www.cell.com${smallPath}`, route => route.fulfill({ contentType: 'image/png', body: png }));
	await context.route(`https://www.cell.com${largePath}`, route => route.fulfill({ contentType: 'image/png', body: largePng }));
	await context.route('https://images.example.org/**', route => route.fulfill({ contentType: 'image/png', body: png }));
	const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
	const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
	await worker.evaluate(() => chrome.storage.local.set({ language: 'en' }));
	const article = await context.newPage();
	await article.goto(cellPage);
	const next = context.waitForEvent('page');
	await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `${origin}/popup.html`);
	const popup = await next;
	const errors = [];
	popup.on('pageerror', error => errors.push(error.message));
	await popup.locator('#note-content-field').waitFor({ state: 'visible' });
	await popup.locator('#save-image-archive').waitFor({ state: 'attached' });
	await popup.waitForFunction(() => document.querySelector('#note-content-field')?.value.includes('Synthetic paper body.'));
	await popup.locator('#note-name-field').fill('Edited synthetic paper');
	const markdown = '# Edited paper\n\n![Panel A](https://images.example.org/a.png?Expires=42&Signature=test)\n\nFigure 1. Preserved caption.\n\n![Panel B](https://images.example.org/a.png?Expires=42&Signature=test)';
	await popup.locator('#note-content-field').fill(markdown);
	await popup.setViewportSize({ width: 1100, height: 900 });
	await popup.locator('#more-btn').click();
	await popup.screenshot({ path: path.join(directory, 'menu-desktop.png') });
	const downloading = popup.waitForEvent('download');
	await popup.locator('#save-image-archive').click();
	const download = await downloading;
	assert.equal(download.suggestedFilename(), 'paper-Edited synthetic paper.zip');
	const zip = unzipSync(await readFile(await download.path()));
	assert.equal(Object.keys(zip).length, 2);
	const md = strFromU8(zip[Object.keys(zip).find(name => name.endsWith('/paper.md'))]);
	assert.match(md, /# Edited paper/);
	assert.match(md, /Figure 1\. Preserved caption\./);
	assert.equal(md.match(/images\/image-1.png/g)?.length, 2);
	const extracted = path.join(directory, 'extracted');
	for (const [name, bytes] of Object.entries(zip)) {
		assert.match(name, /^paper-[0-9a-f-]+\/(?:paper.md|images\/image-1.png)$/);
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
	await popup.locator('#image-archive-status').filter({ hasText: 'ZIP download requested (1 images).' }).waitFor();
	await popup.setViewportSize({ width: 390, height: 844 });
	await popup.screenshot({ path: path.join(directory, 'saved-mobile.png') });
	assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	// The original page, not an invented filename, supplies Cell's different asset ID.
	await popup.locator('#note-content-field').fill(`![Figure](https://www.cell.com${smallPath})\n\nCaption.`);
	for (const fallback of [false, true]) {
		if (fallback) await context.route(`https://www.cell.com${largePath}`, route => route.fulfill({ status: 403, body: 'Denied' }));
		await popup.locator('#more-btn').click();
		const downloading = popup.waitForEvent('download');
		await popup.locator('#save-image-archive').click();
		const archive = unzipSync(await readFile(await (await downloading).path()));
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
	// Exercise a failed retry through the same control: no partial download or editor loss.
	await context.route('https://images.example.org/bad.png', route => route.fulfill({ status: 403, body: 'Not authorized' }));
	const failedNote = '![x](https://images.example.org/bad.png)';
	await popup.locator('#note-content-field').fill(failedNote);
	let extraDownloads = 0;
	popup.on('download', () => extraDownloads++);
	await popup.locator('#more-btn').click();
	await popup.locator('#save-image-archive').click();
	await popup.locator('#image-archive-status').filter({ hasText: 'ZIP not created' }).waitFor();
	assert.equal(extraDownloads, 0);
	assert.equal(await popup.locator('#note-content-field').inputValue(), failedNote);
	await popup.screenshot({ path: path.join(directory, 'failed-mobile.png') });
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ passed: true, screenshots: directory, checks: ['real-menu-download', 'local-images', 'deduplication', 'editor-preserved', 'cell-high-resolution-128px', 'reported-original-fallback', 'failed-retry-no-zip', 'mobile-layout'] }));
} finally { await context.close(); }
