import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fetchPage, main, parseOptions } from './fetch-page.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const paragraph = 'Persistent browser access renders the complete scientific article after authentication. '.repeat(80);
let server;
let baseUrl;
let directory;

before(async () => {
	const output = path.join(root, 'output/browser-fetch/tests');
	await mkdir(output, { recursive: true });
	directory = await mkdtemp(path.join(output, 'run-'));
	server = createServer((request, response) => {
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		if (request.url === '/failure') {
			response.writeHead(403).end('Forbidden');
			return;
		}
		if (request.url === '/login') {
			response.setHeader('Set-Cookie', 'paperAccess=yes; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax');
			response.end('<html><body><main>Session saved</main></body></html>');
			return;
		}
		if (request.url === '/redirect') {
			response.writeHead(302, { Location: '/article' }).end();
			return;
		}
		if (request.url === '/article' && request.headers.cookie?.includes('paperAccess=yes')) {
			response.end(`<!doctype html><html><head><title>Browser fetch regression</title></head>
				<body><article><h1>Browser fetch regression</h1><p>Loading article...</p></article>
				<script>setTimeout(() => {
					document.querySelector('article').innerHTML = '<h1>Browser fetch regression</h1><h2 id="results">Results</h2><p>${paragraph}</p>';
				}, 600);</script></body></html>`);
			return;
		}
		response.end('<html><head><title>Preview</title></head><body><article><h1>Preview</h1><p>This is a preview of subscription content</p></article></body></html>');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	// Keep profiles under the ignored output folder; do not recursively delete them.
});

function options(route, extra = []) {
	return parseOptions([`${baseUrl}${route}`, '--profile', path.join(directory, 'profile'),
		'--output', path.join(directory, 'article.html'), '--timeout', '10000', '--settle', '800', ...extra]);
}

test('rejects unsupported URLs and invalid waits before opening a browser', () => {
	assert.throws(() => parseOptions(['file:///secret']), /HTTP/);
	assert.throws(() => parseOptions(['https://example.com', '--timeout', '0']), /positive integer/);
	assert.throws(() => parseOptions(['https://example.com', '--settle', '60000']), /smaller/);
	assert.throws(() => parseOptions(['https://example.com', '--unknown']), /Unknown option/);
});

test('detects a preview, persists login across browser launches, renders JS, and feeds CLI --html', { timeout: 60000 }, async () => {
	const preview = await fetchPage(options('/article'));
	assert.equal(preview.report.status, 'subscription-preview');
	await fetchPage(options('/login'));
	const captured = await fetchPage(options('/redirect', ['--wait-for', '#results']));
	assert.equal(captured.report.url, `${baseUrl}/article`);
	assert.equal(captured.report.status, 'unchecked');
	assert.ok(captured.report.headings.includes('Results'));
	assert.ok(captured.html.includes(`<p>${paragraph}</p>`));
	const htmlPath = path.join(directory, 'rendered.html');
	const markdownPath = path.join(directory, 'rendered.md');
	await writeFile(htmlPath, captured.html, 'utf8');
	await run(process.execPath, [path.join(root, 'dist/cli.cjs'), captured.report.url,
		'--html', htmlPath, '-t', path.join(root, 'src/utils/fixtures/templates/minimal.json'), '-o', markdownPath]);
	const markdown = await readFile(markdownPath, 'utf8');
	assert.match(markdown, /## Results/);
	assert.ok(markdown.includes(paragraph.trim()));
	assert.ok(!markdown.includes('This is a preview of subscription content'));
});

test('preview CLI writes diagnostic HTML and report with exit code 2', { timeout: 20000 }, async () => {
	const output = path.join(directory, 'preview.html');
	const code = await main([`${baseUrl}/preview`, '--profile', path.join(directory, 'profile'),
		'--output', output, '--settle', '100']);
	assert.equal(code, 2);
	assert.match(await readFile(output, 'utf8'), /preview of subscription content/);
	assert.equal(JSON.parse(await readFile(`${output}.json`, 'utf8')).status, 'subscription-preview');
});

test('HTTP failures and readiness timeouts release the profile and preserve existing output', { timeout: 40000 }, async () => {
	const output = path.join(directory, 'preserved.html');
	await writeFile(output, 'previous capture', 'utf8');
	await assert.rejects(main([`${baseUrl}/failure`, '--profile', path.join(directory, 'profile'), '-o', output]), /HTTP 403/);
	assert.equal(await readFile(output, 'utf8'), 'previous capture');
	await assert.rejects(fetchPage(options('/article', ['--wait-for', '#missing', '--timeout', '1200'])), /Timeout/);
	const retry = await fetchPage(options('/article'));
	assert.ok(retry.report.headings.includes('Results'));
});
