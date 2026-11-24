import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('src/manifest.chrome.json', root), 'utf8'));
const archive = new URL(`builds/paper-clipper-${manifest.version}-chrome.zip`, root);
const files = unzipSync(await readFile(archive));
const artifacts = new Set([
	'manifest.json', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.md', 'LICENSE-lucide.txt', 'LICENSE-fflate.txt',
	'browser-polyfill.min.js', 'flatten-shadow-dom.js', 'icons/paper-clipper.svg', ...Object.values(manifest.icons),
	'content-loader.js', 'background.js', 'content.js', 'reader-script.js', 'reader-page.js',
	'popup.js', 'settings.js', 'highlights.js', 'paper-library.js', 'paper-queue.js', 'paper-save.js',
	'style.css', 'highlighter.css', 'reader.css',
	'paper-library.css', 'paper-queue.css', 'paper-save.css', 'popup.html', 'side-panel.html',
	'settings.html', 'reader.html', 'highlights.html', 'paper-library.html', 'paper-queue.html', 'paper-save.html'
]);
for (const locale of await readdir(new URL('src/_locales/', root), { withFileTypes: true })) {
	if (locale.isDirectory() && /^[a-z]{2}(?:_[A-Z]{2})?$/.test(locale.name)) {
		artifacts.add(`_locales/${locale.name}/messages.json`);
	}
}

const normalize = value => value.replaceAll('\\', '/').replace(/\/{2,}/g, '/').toLowerCase();
const privatePaths = [fileURLToPath(root), homedir()].flatMap(directory => [
	normalize(directory), normalize(pathToFileURL(directory).href)
]).map(value => value.replace(/\/$/, '') + '/');

for (const [name, bytes] of Object.entries(files)) {
	assert.ok(artifacts.has(name), `Unexpected file in Chrome release: ${name}`);
	if (name.endsWith('.png')) continue;
	const content = normalize(Buffer.from(bytes).toString('utf8'));
	assert.ok(!privatePaths.some(value => content.includes(value)), `Build-machine path in ${name}`);
	assert.ok(!/(?:[a-z]:\/users|file:\/(?:users|home))\/[^/\s"']+\//.test(content), `User profile path in ${name}`);
}
for (const name of artifacts) {
	assert.ok(files[name]?.length, `Missing Chrome release asset: ${name}`);
}
assert.deepEqual(JSON.parse(Buffer.from(files['manifest.json']).toString('utf8')), manifest);
console.log(`Verified ${Object.keys(files).length} Chrome release files for version ${manifest.version}.`);
