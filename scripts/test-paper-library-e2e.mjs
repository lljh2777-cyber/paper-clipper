import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Browser plugin not available. Hosted CI uses a synthetic OPFS directory only.
// Flow: Settings -> Archives -> search/sort/refresh -> unchanged files.
const directory = await mkdtemp(path.join(tmpdir(), 'paper-library-qa-'));
const extension = fileURLToPath(new URL('../dev', import.meta.url));
const context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
	channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
	await context.route('https://raw.githubusercontent.com/**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));
	const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
	const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
	await worker.evaluate(async () => {
		await chrome.storage.local.set({ language: 'en' });
		const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Papers', { create: true });
		for (const [folder, title, doi, year, state] of [
			['renamed-paper', 'Novae: a graph-based foundation model for spatial transcriptomics data', '10.1234/novae', '2025', 'complete'],
			['second-paper', 'Language model-guided anticipation and discovery of mammalian metabolites', '10.1234/deepmet', '2026', 'failed'],
			['unsafe-title', '<img src=x onerror=alert(1)> Metadata is text', null, '', 'writing'],
		]) {
			const child = await root.getDirectoryHandle(folder, { create: true });
			const files = { 'translation.json': JSON.stringify({ schemaVersion: 1, sourceFile: 'paper.md', title, doi, published: year,
				createdAt: `${year || '2024'}-01-01T00:00:00Z`, archiveStatus: state, status: 'not-started' }), 'paper.md': 'English original, do not modify.', 'paper.zh-CN.md': 'Existing translation, do not modify.' };
			for (const [name, text] of Object.entries(files)) { const writer = await (await child.getFileHandle(name, { create: true })).createWritable(); await writer.write(text); await writer.close(); }
		}
		const broken = await root.getDirectoryHandle('broken', { create: true });
		const writer = await (await broken.getFileHandle('translation.json', { create: true })).createWritable(); await writer.write('{'); await writer.close();
		await root.getDirectoryHandle('unindexed', { create: true });
		const db = await new Promise((resolve, reject) => {
			const request = indexedDB.open('paper-clipper-directory', 1);
			request.onupgradeneeded = () => request.result.createObjectStore('settings');
			request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
		});
		await new Promise((resolve, reject) => { const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put(root, 'directory'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
	});
	const contents = () => worker.evaluate(async () => {
		const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Papers');
		const files = {};
		for await (const [folder, child] of root.entries()) {
			files[folder] = {};
			for await (const [name, file] of child.entries()) files[folder][name] = await (await file.getFile()).text();
		}
		return files;
	});
	const before = await contents();
	// Trap any archive-page attempt to read notes or create/write/delete files.
	await context.addInitScript(() => {
		const getFileHandle = FileSystemDirectoryHandle.prototype.getFileHandle;
		FileSystemDirectoryHandle.prototype.getFileHandle = function(name, options) {
			if (name !== 'translation.json' || options?.create) throw new Error('Unexpected file access');
			return getFileHandle.call(this, name, options);
		};
		FileSystemFileHandle.prototype.createWritable = () => { throw new Error('Unexpected write'); };
		FileSystemDirectoryHandle.prototype.removeEntry = () => { throw new Error('Unexpected delete'); };
	});
	const settings = await context.newPage();
	await settings.goto(`${origin}/settings.html`);
	const next = context.waitForEvent('page');
	await settings.locator('#paper-library-link').click();
	const page = await next;
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
	await page.locator('.archive-row').first().waitFor();
	assert.equal(await page.title(), 'Paper Clipper | Archives');
	assert.equal(new URL(page.url()).pathname, '/paper-library.html');
	assert.equal(await page.locator('.archive-row').count(), 3);
	assert.match(await page.locator('#library-status').innerText(), /3 matches \/ 3 archives.*No metadata: 1; metadata issues: 1/);
	assert.equal(await page.locator('#library-results img').count(), 0);
	await page.locator('#library-query').fill('https://doi.org/10.1234/NOVAE');
	assert.equal(await page.locator('.archive-row').count(), 1);
	assert.match(await page.locator('.archive-folder').innerText(), /renamed-paper/);
	await page.locator('#library-query').fill('2026');
	assert.match(await page.locator('.archive-row').innerText(), /recorded failed/);
	await page.locator('#library-query').fill('nothing-matches');
	assert.equal(await page.locator('.archive-row').count(), 0);
	assert.match(await page.locator('#library-status').innerText(), /No matching archives/);
	await page.locator('#library-query').fill('');
	await page.locator('#library-sort').selectOption('year');
	assert.match(await page.locator('.archive-row').first().innerText(), /metabolites/);
	await page.locator('#library-refresh').click();
	await page.locator('#library-refresh').waitFor({ state: 'visible' });
	await page.waitForFunction(() => !document.getElementById('library-refresh').disabled);
	for (const [width, height] of [[1280, 900], [390, 844]]) {
		await page.setViewportSize({ width, height });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		await page.screenshot({ path: path.join(directory, `archives-${width}.png`), fullPage: true });
	}
	await page.reload();
	await page.locator('.archive-row').first().waitFor();
	assert.equal(await page.locator('.archive-row').count(), 3);
	assert.deepEqual(await contents(), before);
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ passed: true, directory, filesUnchanged: true, archived: 3 }));
} finally { await context.close(); }
