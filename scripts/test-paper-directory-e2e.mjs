import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
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
	const thumbnail = Buffer.from(await worker.evaluate(async () => {
		const canvas = new OffscreenCanvas(1, 1);
		canvas.getContext('2d').fillRect(0, 0, 1, 1);
		return [...new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())];
	}));
	const png = await readFile(new URL('../src/icons/icon128.png', import.meta.url));
	const smallImage = 'https://media.springernature.com/lw685/springer-static/image/art%3A10.1234%2Ftest/MediaObjects/Fig1.png';
	await context.route('https://raw.githubusercontent.com/**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));
	await context.route('https://paper.example.org/**', route => route.fulfill({ contentType: 'text/html', body: '<html><head><title>Synthetic paper</title><meta name="citation_doi" content="10.1234/example"><meta name="citation_publication_date" content="2025-01-02"></head><body><article><h1>Synthetic paper</h1><p>' + 'Synthetic paper body. '.repeat(100) + '</p></article></body></html>' }));
	await context.route('https://images.example.org/**', route => route.fulfill({ contentType: 'image/png', body: png }));
	await context.route(smallImage, route => route.fulfill({ contentType: 'image/png', body: thumbnail }));
	await context.route(smallImage.replace('/lw685/', '/full/'), route => route.fulfill({ contentType: 'image/png', body: png }));
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
	const markdown = `# English source\n\n![Figure](${smallImage})\n\nCaption.`;
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
		const imageReport = JSON.parse(await read('image-report.json'));
		const image = await (await (await folder.getDirectoryHandle('images')).getFileHandle('image-1.png')).getFile();
		const bitmap = await createImageBitmap(image);
		const dimensions = [bitmap.width, bitmap.height]; bitmap.close();
		const entries = []; for await (const [name] of folder.entries()) entries.push(name);
		// A pre-existing translation must survive subsequent saves and forgetting the root.
		const writer = await (await folder.getFileHandle('paper.zh-CN.md', { create: true })).createWritable();
		await writer.write('人工译文'); await writer.close();
		return { original, metadata, imageReport, dimensions, entries };
	});
	assert.deepEqual(bundle.entries.sort(), ['image-report.json', 'images', 'paper.md', 'translation.json']);
	assert.match(bundle.original, /images\/image-1.png/);
	assert.equal(bundle.metadata.status, 'not-started');
	assert.equal(bundle.metadata.archiveStatus, 'complete');
	assert.equal(bundle.metadata.doi, '10.1234/example');
	assert.deepEqual(bundle.dimensions, [128, 128]);
	assert.equal(bundle.imageReport.items[0].selection, 'preferred');
	await popup.locator('#clip-btn').click();
	await popup.locator('#image-archive-status').filter({ hasText: '已存在' }).waitFor();
	assert.equal(await popup.locator('#note-content-field').inputValue(), markdown);
	// Exercise the actual cross-origin frame, not just a standalone popup. The
	// permission adapter below simulates prompts over OPFS; no personal grants.
	await context.addInitScript(() => {
		if (location.pathname === '/side-panel.html' && window.top !== window) {
			window.permissionCalls = 0;
			for (const method of ['queryPermission', 'requestPermission']) {
				FileSystemHandle.prototype[method] = async () => {
					window.permissionCalls++;
					throw new DOMException('Iframe permission call forbidden by QA', 'SecurityError');
				};
			}
		}
		if (location.pathname === '/paper-save.html' && localStorage.getItem('qa-permission') === 'prompt') {
			let state = 'prompt';
			window.permissionClicks = [];
			FileSystemHandle.prototype.queryPermission = async () => state;
			FileSystemHandle.prototype.requestPermission = async () => {
				window.permissionClicks.push(navigator.userActivation.isActive);
				state = window.permissionClicks.length === 1 ? 'denied' : 'granted';
				return state;
			};
		}
	});
	await article.bringToFront();
	await worker.evaluate(async () => {
		const [tab] = await chrome.tabs.query({ url: 'https://paper.example.org/article' });
		await chrome.tabs.sendMessage(tab.id, { action: 'toggle-iframe' });
	});
	const embedded = article.frameLocator('#obsidian-clipper-iframe');
	await embedded.locator('#note-content-field').filter({ visible: true }).waitFor();
	const frame = article.frames().find(frame => frame.url().includes('/side-panel.html'));
	await frame.waitForFunction(() => document.querySelector('#note-content-field')?.value.includes('Synthetic paper body.'));
	const openSave = async title => {
		await article.bringToFront();
		await article.setViewportSize({ width: 1280, height: 900 });
		await embedded.locator('#note-name-field').fill(title);
		await embedded.locator('#note-content-field').fill(markdown + '\n\nEdited in the embedded clipper.');
		const next = context.waitForEvent('page');
		await embedded.locator('#clip-btn').click();
		const save = await next.catch(async error => {
			await article.screenshot({ path: path.join(directory, 'embedded-failure.png') });
			throw new Error(`Save tab did not open: ${await embedded.locator('#image-archive-status').textContent()}`, { cause: error });
		});
		save.on('pageerror', error => errors.push(error.message));
		await save.waitForURL(`${origin}/paper-save.html#*`);
		await embedded.locator('#image-archive-status').filter({ hasText: '交给保存页' }).waitFor();
		assert.equal(await frame.evaluate(() => window.permissionCalls), 0);
		assert.match(await embedded.locator('#note-content-field').inputValue(), /Edited in the embedded clipper/);
		return save;
	};
	const readEmbedded = async title => settings.evaluate(async title => {
		const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Literature_translation');
		const folder = await root.getDirectoryHandle(`2025_${title}__10.1234_example`);
		return {
			markdown: await (await (await folder.getFileHandle('paper.md')).getFile()).text(),
			metadata: JSON.parse(await (await (await folder.getFileHandle('translation.json')).getFile()).text()),
			imageSize: (await (await (await folder.getDirectoryHandle('images')).getFileHandle('image-1.png')).getFile()).size,
		};
	}, title);
	let save = await openSave('Embedded edited title');
	await save.locator('#save-status').filter({ hasText: '已保存：Literature_translation/2025_Embedded_edited_title__10.1234_example' }).waitFor();
	assert.equal(await save.title(), 'Paper Clipper | Save');
	assert.equal(await save.locator('#authorize-save').isVisible(), false);
	const embeddedBundle = await readEmbedded('Embedded_edited_title');
	assert.match(embeddedBundle.markdown, /Edited in the embedded clipper/);
	assert.match(embeddedBundle.markdown, /^---\r?\n/);
	assert.match(embeddedBundle.markdown, /images\/image-1.png/);
	assert.equal(embeddedBundle.imageSize, png.length);
	assert.equal(embeddedBundle.metadata.title, 'Embedded edited title');
	assert.equal(embeddedBundle.metadata.sourceUrl, 'https://paper.example.org/article');
	assert.equal(embeddedBundle.metadata.doi, '10.1234/example');
	assert.equal(embeddedBundle.metadata.archiveStatus, 'complete');
	assert.equal(await worker.evaluate(async () => (await chrome.storage.session.get('paperDirectorySaveDraft')).paperDirectorySaveDraft), undefined);
	await save.setViewportSize({ width: 1280, height: 900 });
	await save.screenshot({ path: path.join(directory, 'save-desktop.png') });
	await save.setViewportSize({ width: 390, height: 844 });
	assert.equal(await save.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await save.screenshot({ path: path.join(directory, 'save-mobile.png') });
	await save.reload();
	await save.locator('#save-status').filter({ hasText: '未重复保存' }).waitFor();
	assert.deepEqual(await readEmbedded('Embedded_edited_title'), embeddedBundle);
	await save.close();
	save = await openSave('Embedded edited title');
	await save.locator('#save-status').filter({ hasText: '已存在' }).waitFor();
	assert.deepEqual(await readEmbedded('Embedded_edited_title'), embeddedBundle);
	await save.close();
	await settings.evaluate(() => localStorage.setItem('qa-permission', 'prompt'));
	save = await openSave('Permission test');
	await save.locator('#save-status').filter({ hasText: '等待目录访问授权' }).waitFor();
	assert.deepEqual(await save.evaluate(() => window.permissionClicks), []);
	await save.locator('#authorize-save').click();
	await save.locator('#save-status').filter({ hasText: '未获得目录写入权限' }).waitFor();
	assert.equal(await save.locator('#authorize-save').isVisible(), true);
	await save.locator('#authorize-save').click();
	await save.locator('#save-status').filter({ hasText: '已保存：' }).waitFor();
	assert.deepEqual(await save.evaluate(() => window.permissionClicks), [true, true]);
	assert.equal((await readEmbedded('Permission_test')).metadata.archiveStatus, 'complete');
	await save.close();
	save = await openSave('Cancelled permission test');
	await save.locator('#save-status').filter({ hasText: '等待目录访问授权' }).waitFor();
	await save.locator('#close-save').click();
	await settings.evaluate(() => localStorage.removeItem('qa-permission'));
	assert.equal(await settings.evaluate(async () => {
		const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Literature_translation');
		for await (const name of root.keys()) if (name.includes('Cancelled_permission_test')) return true;
		return false;
	}), false);
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
	console.log(JSON.stringify({ passed: true, screenshots: directory, checks: ['settings-picker-adapter', 'handle-persistence-after-reload', 'default-action', 'real-files-and-image', 'collision-protection', 'forget-keeps-files', 'missing-directory', 'responsive-settings', 'cross-origin-embedded-handoff', 'edited-snapshot-preserved', 'no-iframe-permission-call', 'no-reload-replay', 'simulated-permission-denial-and-user-gesture', 'cancel-before-writes', 'responsive-save-page'] }));
} finally { await context.close(); }
