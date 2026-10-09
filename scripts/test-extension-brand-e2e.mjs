import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'paper-brand-qa-'));
const extension = path.join(root, 'dev');
const context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
	channel: 'chromium', headless: true,
	args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
	const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
	const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
	const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
	assert.equal(manifest.name, 'Paper Clipper');
	assert.equal(manifest.description, await worker.evaluate(() => chrome.i18n.getMessage('extensionDescription')));
	assert.doesNotMatch(manifest.description, /__MSG_/);
	// Isolated synthetic storage and provider response; never use the user's profile.
	await context.route('https://raw.githubusercontent.com/**/providers.json', route => route.fulfill({ contentType: 'application/json', body: '{"version":"test"}' }));
	const pairing = { endpoint: 'http://127.0.0.1:43127', key: 'a'.repeat(64), enabled: false };
	await worker.evaluate(async pairing => {
		await chrome.storage.local.set({ paperQueuePairing: pairing, language: 'en' });
	}, pairing);
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
	for (const language of ['en', 'zh_CN']) {
		await worker.evaluate(language => chrome.storage.local.set({ language }), language);
		await page.goto(`${origin}/settings.html`);
		await page.waitForFunction(() => document.querySelector('#version-number')?.textContent?.trim());
		assert.match(await page.title(), /Paper Clipper/);
		await page.locator('#paper-queue-link').waitFor();
		assert.equal(await page.locator('#rate-extension').count(), 0);
		assert.equal(await page.locator('#using-latest-version').innerText(), language === 'en' ? 'Local development build' : '本地开发版本');
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.emulateMedia({ colorScheme: 'light' });
		await page.screenshot({ path: path.join(directory, `settings-${language}-desktop.png`) });
		assert.equal(await page.locator('img.logo').first().evaluate(img => img.complete && img.naturalWidth > 0), true);
		const queuePromise = context.waitForEvent('page');
		await page.locator('#paper-queue-link').click();
		const queue = await queuePromise;
		await queue.waitForLoadState();
		assert.equal(await queue.title(), 'Paper Clipper | Browser Queue');
		await queue.getByRole('button', { name: 'Connect', exact: true }).waitFor();
		await queue.close();
		await page.setViewportSize({ width: 390, height: 844 });
		await page.emulateMedia({ colorScheme: 'dark' });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		await page.locator('#hamburger-menu').click();
		await page.locator('#sidebar li[data-section="properties"]').click();
		await page.locator('#properties-section.active').waitFor();
		await page.locator('#hamburger-menu').click();
		await page.locator('#sidebar li[data-section="general"]').click();
		await page.locator('#general-section.active').waitFor();
		await page.screenshot({ path: path.join(directory, `settings-${language}-mobile-dark.png`) });
		const stored = await worker.evaluate(() => chrome.storage.local.get('paperQueuePairing'));
		assert.deepEqual(stored.paperQueuePairing, pairing);
	}
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ passed: true, screenshots: directory, checks: ['settings-en-zh', 'queue-navigation', 'mobile-sidebar', 'pairing-retained', 'console-clean'] }));
} finally {
	await context.close();
}
