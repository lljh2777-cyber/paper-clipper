import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startQueue, parseOptions } from './browser-queue.mjs';
import { savePaper } from './save-paper.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(process.env.PAPER_QUEUE_QA_DIR ?? tmpdir(), 'paper-queue-qa-'));
const paragraph = 'This research compares tissue expression and spatial organization across biological samples. '.repeat(100);
const full = `<html><head><title>Public synthetic paper</title></head><body><article><h1>Public synthetic paper</h1><h2>Results</h2><p>${paragraph}</p><h2>Methods</h2><p>${paragraph}</p></article></body></html>`;
let releasePaper;
const fixture = createServer((request, response) => {
	if (request.url === '/paper' && !releasePaper) { releasePaper = () => response.end(full); response.setHeader('Content-Type', 'text/html'); return; }
	if (request.url === '/unlock') { response.writeHead(302, { 'Set-Cookie': 'fixture_access=yes; Path=/; SameSite=Lax', Location: '/restricted' }).end(); return; }
	response.setHeader('Content-Type', 'text/html');
	response.end(request.url === '/restricted' && !request.headers.cookie?.includes('fixture_access=yes') ?
		'<html><head><title>Just a moment</title></head><body><h1>Synthetic access check</h1><a href="/unlock">Grant fixture access</a></body></html>' : full);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${fixture.address().port}`;
const options = parseOptions([`${base}/paper`, `${base}/restricted`, '-o', path.join(directory, 'output')]); options.port = 0;
let queue, context;
async function until(check, timeout = 90000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 250)); }
	throw new Error('Timed out waiting for background queue state.');
}
const reportNow = async () => JSON.parse(await readFile(queue.reportPath, 'utf8'));
try {
	queue = await startQueue(options, { log: () => {} });
	const extension = path.join(root, 'dev');
	await mkdir(path.join(directory, 'profile'));
	context = await chromium.launchPersistentContext(path.join(directory, 'profile'), { channel: 'chromium', headless: true,
		args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
	let worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
	const id = new URL(worker.url()).hostname;
	const unrelated = await context.newPage(); await unrelated.goto(`${base}/personal`);
	const rejected = await worker.evaluate(async () => {
		const [tab] = await chrome.tabs.query({ url: '*://127.0.0.1/*personal' });
		return (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => chrome.runtime.sendMessage({ action: 'paperQueue', op: 'disconnect' }) }))[0].result;
	});
	assert.match(rejected.error, /extension queue page/);
	let page = await context.newPage(); const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
	await page.goto(`chrome-extension://${id}/paper-queue.html`);
	assert.equal(await page.title(), 'Paper Clipper | Browser Queue');
	await page.locator('#endpoint').fill(queue.url); await page.locator('#key').fill(queue.key);
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
	await until(async () => (await reportNow()).jobs[0].status === 'claimed' && !!releasePaper);
	await page.close();
	assert.equal(context.pages().some(tab => tab.url().endsWith('/paper-queue.html')), false);
	// Stop the worker, not the browser: session-owned task tabs must survive and recover via alarm.
	const cdp = await context.newCDPSession(unrelated); let versions = [];
	cdp.on('ServiceWorker.workerVersionUpdated', event => { versions = [...versions, ...event.versions]; });
	await cdp.send('ServiceWorker.enable');
	await until(async () => versions.some(version => version.scriptURL === `chrome-extension://${id}/background.js` && version.runningStatus === 'running'), 10000);
	const version = versions.findLast(version => version.scriptURL === `chrome-extension://${id}/background.js` && version.runningStatus === 'running');
	await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
	releasePaper();
	await until(async () => (await reportNow()).jobs[0].status === 'saved');
	await until(async () => (await reportNow()).jobs[1].status === 'paused');
	assert.equal(context.pages().some(tab => tab.url().endsWith('/paper-queue.html')), false);
	await cdp.detach();
	page = await context.newPage();
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
	await page.goto(`chrome-extension://${id}/paper-queue.html`);
	const first = page.locator('.task').filter({ has: page.getByRole('heading', { name: `${base}/paper`, exact: true }) });
	await first.locator('.state').getByText('saved', { exact: true }).waitFor({ timeout: 60000 });
	const blocked = page.locator('.task').filter({ has: page.getByRole('heading', { name: `${base}/restricted`, exact: true }) });
	await blocked.locator('.state').getByText('paused', { exact: true }).waitFor({ timeout: 30000 });
	await blocked.getByRole('button', { name: /Open task tab/ }).click();
	const accessPage = context.pages().find(tab => tab.url() === `${base}/restricted`);
	assert.ok(accessPage); await accessPage.getByRole('link', { name: 'Grant fixture access' }).click();
	await accessPage.waitForURL(`${base}/restricted`);
	await blocked.getByRole('button', { name: /Resume after review/ }).click();
	await page.close();
	await until(async () => (await reportNow()).jobs[1].status === 'saved');
	page = await context.newPage();
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
	await page.goto(`chrome-extension://${id}/paper-queue.html`);
	await page.locator('.task .state').getByText('saved', { exact: true }).first().waitFor();
	assert.equal(unrelated.isClosed(), false);
	assert.equal(context.pages().filter(tab => [`${base}/paper`, `${base}/restricted`].includes(tab.url())).length, 0);
	const report = JSON.parse(await readFile(queue.reportPath, 'utf8'));
	assert.deepEqual(report.jobs.map(job => job.status), ['saved', 'saved']);
	assert.ok(report.jobs.every(job => job.result.conversion.quality.completeness.status === 'passed-heuristics'));
	assert.equal(await page.locator('#error').isVisible(), false);
	await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
	await page.getByText('Disconnected', { exact: true }).waitFor();
	const oldKey = queue.key;
	const originals = await Promise.all(report.jobs.map(job => readFile(job.result.output, 'utf8')));
	// Editing the form must not redirect a reset of the connected service.
	await page.locator('#endpoint').fill('http://127.0.0.1:1024');
	page.once('dialog', dialog => dialog.accept());
	await page.getByRole('button', { name: 'Reset pairing', exact: true }).click();
	await page.locator('#pairing-notice').waitFor();
	assert.notEqual(queue.key, oldKey);
	assert.equal(await readFile(path.join(options.outputDir, 'pairing-key.txt'), 'utf8'), queue.key);
	assert.equal((await fetch(`${queue.url}/v1/jobs`, { headers: { Authorization: `Bearer ${oldKey}` } })).status, 401);
	assert.equal(await page.locator('#endpoint').inputValue(), queue.url);
	assert.equal(await page.locator('#key').getAttribute('type'), 'password');
	assert.ok(!(await page.locator('body').innerText()).includes(queue.key));
	assert.deepEqual(await Promise.all(report.jobs.map(job => readFile(job.result.output, 'utf8'))), originals);
	await page.locator('#key').fill('');
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.screenshot({ path: path.join(directory, 'desktop.png'), fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await page.screenshot({ path: path.join(directory, 'mobile.png'), fullPage: true });
	const second = await context.newPage(); await second.goto(`chrome-extension://${id}/paper-queue.html`);
	await second.getByText('Disconnected', { exact: true }).waitFor();
	await page.close(); await second.reload();
	await second.getByRole('button', { name: 'Connect', exact: true }).click();
	await second.getByText('Connected', { exact: true }).waitFor({ timeout: 10000 });
	assert.deepEqual(errors, []);
	await second.close();
	const idleCdp = await context.newCDPSession(unrelated); let idleVersions = [];
	idleCdp.on('ServiceWorker.workerVersionUpdated', event => { idleVersions.push(...event.versions); });
	await idleCdp.send('ServiceWorker.enable');
	await until(async () => idleVersions.some(version => version.scriptURL === `chrome-extension://${id}/background.js` && version.runningStatus === 'running'), 10000);
	const idleVersion = idleVersions.findLast(version => version.scriptURL === `chrome-extension://${id}/background.js` && version.runningStatus === 'running');
	await idleCdp.send('ServiceWorker.stopWorker', { versionId: idleVersion.versionId });
	options.port = Number(new URL(queue.url).port);
	await queue.close();
	options.queries = [`${base}/alarm-paper`];
	queue = await startQueue(options, { log: () => {} });
	await until(async () => (await reportNow()).jobs[0].status === 'saved');
	assert.equal(context.pages().some(tab => tab.url().endsWith('/paper-queue.html')), false);
	await idleCdp.detach();
	// A full browser restart keeps enabled pairing but does not keep ownership of old tab IDs.
	await context.close(); await queue.close();
	options.queries = [`${base}/restart-paper`];
	let submissions = 0;
	queue = await startQueue(options, { log: () => {}, runPaper: async (...args) => {
		submissions++; await new Promise(resolve => setTimeout(resolve, 22000)); return savePaper(...args);
	} });
	context = await chromium.launchPersistentContext(path.join(directory, 'profile'), { channel: 'chromium', headless: true,
		args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
	await until(async () => (await reportNow()).jobs[0].status === 'saved');
	assert.equal(submissions, 1);
	const reopened = await context.newPage(); await reopened.goto(`chrome-extension://${id}/paper-queue.html`);
	const externalReset = await fetch(`${queue.url}/v1/pairing/reset`, { method: 'POST', headers: { Authorization: `Bearer ${queue.key}`, 'Content-Type': 'application/json' }, body: '{}' });
	assert.equal(externalReset.status, 200); await externalReset.json();
	await reopened.getByText('Re-pair required', { exact: true }).waitFor({ timeout: 90000 });
	assert.equal(await reopened.locator('#key').inputValue(), '');
	assert.equal(await reopened.evaluate(async () => (await chrome.storage.local.get('paperQueuePairing')).paperQueuePairing), undefined);
	console.log(JSON.stringify({ status: 'passed', directory, checks: ['all queue views closed during acquisition', 'forced worker termination and alarm recovery', 'browser restart without queue view', 'slow conversion reconciled without replay', 'content-script controls rejected', 'real extension capture', 'human fixture access pause/resume', 'automatic conversion', 'task-tab cleanup', 'unrelated tab retained', 'pairing reset/reload', 'old key revoked', 'saved notes unchanged', 'multiple views, single background controller', 'desktop/mobile layout', 'no page errors'] }, null, 2));
} finally {
	await context?.close(); await queue?.close();
	await new Promise(resolve => fixture.close(resolve));
}
