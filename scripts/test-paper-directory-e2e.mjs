import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Browser plugin not available. Use isolated Chromium; never authorize a personal directory.
// A synthetic picker returns a real OPFS handle. Native OS picker consent still needs manual QA.
const directory = await mkdtemp(path.join(tmpdir(), 'paper-directory-qa-'));
const extension = fileURLToPath(new URL('../dev', import.meta.url));
const context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
	channel: 'chromium', headless: true,
	args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
	const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
	const png = Buffer.from(await worker.evaluate(async () => {
		const canvas = new OffscreenCanvas(1, 1);
		canvas.getContext('2d').fillRect(0, 0, 1, 1);
		return [...new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())];
	}));
	await context.route('https://raw.githubusercontent.com/**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));
	await context.route('https://paper.example.org/**', route => route.fulfill({ contentType: 'text/html', body: '<html><head><title>Synthetic paper</title><meta name="citation_doi" content="10.1234/example"><meta name="citation_publication_date" content="2025-01-02"></head><body><article><h1>Synthetic paper</h1><p>' + 'Synthetic paper body. '.repeat(100) + '</p></article></body></html>' }));
	await context.route('https://images.example.org/**', route => route.fulfill({ contentType: 'image/png', body: png }));
	const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
	await worker.evaluate(() => chrome.storage.local.set({ language: 'zh_CN' }));
	const settings = await context.newPage();
	const errors = [];
	settings.on('pageerror', error => errors.push(error.message));
	await settings.goto(`${origin}/settings.html`);
	await settings.locator('#paper-directory-name').filter({ hasText: '未设置' }).waitFor();
	assert.equal(await settings.evaluate(() => typeof window.showDirectoryPicker), 'function');
	await settings.evaluate(() => {
		window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Literature_translation', { create: true });
	});
	await settings.locator('#choose-paper-directory').click();
	await settings.locator('#paper-directory-name').filter({ hasText: 'Literature_translation' }).waitFor();
	await settings.locator('#save-behavior-dropdown').selectOption('savePaperDirectory');
	await settings.waitForFunction(async () => (await chrome.storage.sync.get('general_settings')).general_settings?.saveBehavior === 'savePaperDirectory');
	await settings.reload();
	await settings.locator('#paper-directory-name').filter({ hasText: 'Literature_translation' }).waitFor();
	assert.equal(await settings.locator('#save-behavior-dropdown').inputValue(), 'savePaperDirectory');
	await settings.setViewportSize({ width: 1280, height: 900 });
	await settings.locator('#paper-directory-setting').scrollIntoViewIfNeeded();
	await settings.screenshot({ path: path.join(directory, 'settings-desktop.png') });
	await settings.setViewportSize({ width: 390, height: 844 });
	await settings.locator('#paper-directory-setting').scrollIntoViewIfNeeded();
	assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await settings.screenshot({ path: path.join(directory, 'settings-mobile.png') });
	const article = await context.newPage();
	await article.goto('https://paper.example.org/article');
	const next = context.waitForEvent('page');
	await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `${origin}/popup.html`);
	const popup = await next;
	popup.on('pageerror', error => errors.push(error.message));
	await popup.waitForFunction(() => document.querySelector('#note-content-field')?.value.includes('Synthetic paper body.'));
	const markdown = '# English source\n\n![Figure](https://images.example.org/a.png)\n\nCaption.';
	await popup.locator('#note-name-field').fill('Synthetic paper');
	await popup.locator('#note-content-field').fill(markdown);
	assert.equal(await popup.locator('#clip-btn').innerText(), '保存到默认目录');
	await popup.locator('#clip-btn').click();
	await popup.locator('#image-archive-status').filter({ hasText: '已保存：Literature_translation/2025_Synthetic_paper__10.1234_example' }).waitFor();
	const bundle = await settings.evaluate(async () => {
		const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Literature_translation');
		const folder = await root.getDirectoryHandle('2025_Synthetic_paper__10.1234_example');
		const read = async name => (await (await folder.getFileHandle(name)).getFile()).text();
		const original = await read('paper.md');
		const metadata = JSON.parse(await read('translation.json'));
		const image = await (await (await folder.getDirectoryHandle('images')).getFileHandle('image-1.png')).getFile();
		const bitmap = await createImageBitmap(image);
		const dimensions = [bitmap.width, bitmap.height]; bitmap.close();
		const entries = []; for await (const [name] of folder.entries()) entries.push(name);
		// A pre-existing translation must survive subsequent saves and forgetting the root.
		const writer = await (await folder.getFileHandle('paper.zh-CN.md', { create: true })).createWritable();
		await writer.write('人工译文'); await writer.close();
		return { original, metadata, dimensions, entries };
	});
	assert.deepEqual(bundle.entries.sort(), ['images', 'paper.md', 'translation.json']);
	assert.match(bundle.original, /images\/image-1.png/);
	assert.equal(bundle.metadata.status, 'not-started');
	assert.equal(bundle.metadata.archiveStatus, 'complete');
	assert.equal(bundle.metadata.doi, '10.1234/example');
	assert.deepEqual(bundle.dimensions, [1, 1]);
	await popup.locator('#clip-btn').click();
	await popup.locator('#image-archive-status').filter({ hasText: '已存在' }).waitFor();
	assert.equal(await popup.locator('#note-content-field').inputValue(), markdown);
	await settings.locator('#forget-paper-directory').click();
	await settings.locator('#paper-directory-name').filter({ hasText: '未设置' }).waitFor();
	await popup.locator('#clip-btn').click();
	await popup.locator('#image-archive-status').filter({ hasText: '请先在设置中选择' }).waitFor();
	assert.equal(await settings.evaluate(async () => {
		const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Literature_translation');
		const folder = await root.getDirectoryHandle('2025_Synthetic_paper__10.1234_example');
		return (await (await folder.getFileHandle('paper.zh-CN.md')).getFile()).text();
	}), '人工译文');
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ passed: true, screenshots: directory, checks: ['settings-picker-adapter', 'handle-persistence-after-reload', 'default-action', 'real-files-and-image', 'collision-protection', 'forget-keeps-files', 'missing-directory', 'responsive-settings'] }));
} finally { await context.close(); }
