import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseHTML } from 'linkedom';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = file => readFile(path.join(root, file), 'utf8');
const json = async file => JSON.parse(await text(file));
const repository = 'https://github.com/lljh2777-cyber/paper-clipper';

test('every locale identifies the independent extension, including native browser metadata', async () => {
	for (const locale of await readdir(path.join(root, 'src/_locales'))) {
		const messages = await json(`src/_locales/${locale}/messages.json`);
		assert.equal(messages.extensionName.message, 'Paper Clipper', locale);
		assert.ok(messages.extensionDescription.message.length <= 132, locale);
		assert.doesNotMatch(messages.extensionDescription.message, /The official|Obsidian 官方浏览器|這是 Obsidian 官方/);
		assert.doesNotMatch(messages.commandOpenClipper.message, /Obsidian/);
	}
	for (const browser of ['chrome', 'firefox', 'safari']) {
		const manifest = await json(`src/manifest.${browser}.json`);
		assert.equal(manifest.name, '__MSG_extensionName__');
		assert.equal(manifest.description, '__MSG_extensionDescription__');
		assert.equal(manifest.default_locale, 'en');
		assert.equal(manifest.homepage_url, repository);
	}
});

test('Chrome permissions and identity mechanism stay unchanged', async () => {
	const manifest = await json('src/manifest.chrome.json');
	assert.deepEqual(manifest.permissions, ['alarms', 'activeTab', 'clipboardWrite', 'commands', 'contextMenus', 'sidePanel', 'storage', 'scripting', 'declarativeNetRequest']);
	assert.deepEqual(manifest.host_permissions, ['<all_urls>', 'http://*/*', 'https://*/*']);
	assert.equal(manifest.key, undefined);
	assert.equal(manifest.update_url, undefined);
	assert.equal(manifest.background.service_worker, 'background.js');
});

test('packaged pages, icons and notices use the intended branding', async () => {
	const manifest = await json('dev/manifest.json');
	assert.equal(manifest.name, '__MSG_extensionName__');
	assert.equal((await json('dev/_locales/en/messages.json')).extensionName.message, 'Paper Clipper');
	for (const file of ['settings.html', 'popup.html', 'side-panel.html', 'highlights.html', 'reader.html', 'paper-queue.html']) {
		const html = await text(`dev/${file}`);
		const { document } = parseHTML(html);
		assert.match(document.title, /Paper Clipper/, file);
		assert.doesNotMatch(html, /M94\.82 149\.44/);
		for (const img of document.querySelectorAll('img[src^="icons/"]')) {
			assert.ok((await readFile(path.join(root, 'dev', img.getAttribute('src')))).length > 0);
		}
	}
	const { document } = parseHTML(await text('dev/settings.html'));
	assert.equal(document.querySelector('#paper-queue-link').getAttribute('href'), 'paper-queue.html');
	assert.equal(document.querySelector('#rate-extension'), null);
	assert.equal(document.querySelector('#feedback-modal'), null);
	assert.ok(document.querySelector(`a[href="${repository}/issues"]`));
	assert.ok(document.querySelector('a[href="THIRD_PARTY_NOTICES.md"]'));
	assert.equal(await text('dev/LICENSE.txt'), await text('LICENSE'));
	assert.equal(await text('dev/LICENSE-lucide.txt'), await text('node_modules/lucide/LICENSE'));
	assert.equal(await text('dev/THIRD_PARTY_NOTICES.md'), await text('THIRD_PARTY_NOTICES.md'));
	for (const size of [16, 48, 128]) {
		const png = await readFile(path.join(root, 'dev', manifest.icons[String(size)]));
		assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
		assert.equal(png.readUInt32BE(16), size);
		assert.equal(png.readUInt32BE(20), size);
	}
	assert.doesNotMatch(await text('dev/settings.js'), /chromewebstore\.google\.com\/detail\/obsidian|addons\.mozilla\.org\/en-US\/firefox\/addon\/web-clipper-obsidian/);
});
