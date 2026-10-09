import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startQueue, parseOptions } from './browser-queue.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(process.env.PAPER_QUEUE_QA_DIR ?? tmpdir(), 'paper-queue-qa-'));
const paragraph = 'This research compares tissue expression and spatial organization across biological samples. '.repeat(100);
const full = `<html><head><title>Public synthetic paper</title></head><body><article><h1>Public synthetic paper</h1><h2>Results</h2><p>${paragraph}</p><h2>Methods</h2><p>${paragraph}</p></article></body></html>`;
const fixture = createServer((request, response) => {
	if (request.url === '/unlock') { response.writeHead(302, { 'Set-Cookie': 'fixture_access=yes; Path=/; SameSite=Lax', Location: '/restricted' }).end(); return; }
	response.setHeader('Content-Type', 'text/html');
	response.end(request.url === '/restricted' && !request.headers.cookie?.includes('fixture_access=yes') ?
		'<html><head><title>Just a moment</title></head><body><h1>Synthetic access check</h1><a href="/unlock">Grant fixture access</a></body></html>' : full);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${fixture.address().port}`;
const options = parseOptions([`${base}/paper`, `${base}/restricted`, '-o', path.join(directory, 'output')]); options.port = 0;
let queue, context;
try {
	queue = await startQueue(options, { log: () => {} });
	const extension = path.join(root, 'dev');
	await mkdir(path.join(directory, 'profile'));
	context = await chromium.launchPersistentContext(path.join(directory, 'profile'), { channel: 'chromium', headless: true,
		args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
	const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
	const id = new URL(worker.url()).hostname;
	const unrelated = await context.newPage(); await unrelated.goto(`${base}/personal`);
	const page = await context.newPage(); const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
	await page.goto(`chrome-extension://${id}/paper-queue.html`);
	assert.equal(await page.title(), 'Paper Clipper | Browser Queue');
	await page.locator('#endpoint').fill(queue.url); await page.locator('#key').fill(queue.key);
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
	const first = page.locator('.task').filter({ has: page.getByRole('heading', { name: `${base}/paper`, exact: true }) });
	await first.locator('.state').getByText('saved', { exact: true }).waitFor({ timeout: 60000 });
	const blocked = page.locator('.task').filter({ has: page.getByRole('heading', { name: `${base}/restricted`, exact: true }) });
	await blocked.locator('.state').getByText('paused', { exact: true }).waitFor({ timeout: 30000 });
	await blocked.getByRole('button', { name: /Open task tab/ }).click();
	const accessPage = context.pages().find(tab => tab.url() === `${base}/restricted`);
	assert.ok(accessPage); await accessPage.getByRole('link', { name: 'Grant fixture access' }).click();
	await accessPage.waitForURL(`${base}/restricted`);
	await blocked.getByRole('button', { name: /Resume after review/ }).click();
	await blocked.locator('.state').getByText('saved', { exact: true }).waitFor({ timeout: 60000 });
	assert.equal(unrelated.isClosed(), false);
	assert.equal(context.pages().filter(tab => [`${base}/paper`, `${base}/restricted`].includes(tab.url())).length, 0);
	const report = JSON.parse(await readFile(queue.reportPath, 'utf8'));
	assert.deepEqual(report.jobs.map(job => job.status), ['saved', 'saved']);
	assert.ok(report.jobs.every(job => job.result.conversion.quality.completeness.status === 'passed-heuristics'));
	assert.equal(await page.locator('#error').isVisible(), false);
	await page.locator('#key').fill('');
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.screenshot({ path: path.join(directory, 'desktop.png'), fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await page.screenshot({ path: path.join(directory, 'mobile.png'), fullPage: true });
	const second = await context.newPage(); await second.goto(`chrome-extension://${id}/paper-queue.html`);
	await second.getByText('Another queue page is open', { exact: true }).waitFor();
	await page.close(); await second.reload();
	await second.getByText('Connected', { exact: true }).waitFor({ timeout: 10000 });
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ status: 'passed', directory, checks: ['real extension capture', 'human fixture access pause/resume', 'automatic conversion', 'task-tab cleanup', 'unrelated tab retained', 'pairing reload', 'single controller', 'desktop/mobile layout', 'no page errors'] }, null, 2));
} finally {
	await context?.close(); await queue?.close();
	await new Promise(resolve => fixture.close(resolve));
}
