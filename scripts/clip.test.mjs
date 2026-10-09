import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { clip, nextStep, parseOptions, printResult } from './clip.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const paragraph = 'This research compares tissue expression and spatial organization across biological samples. '.repeat(80);
const article = `<h1>Unified research fixture</h1><h2>Results</h2><p>${paragraph}</p><h2>Methods</h2><p>${paragraph}</p>
	<p><a href="/figures/1">Figure 1</a></p><p>Formula <span class="mathjax-tex">\\(x_i + \\alpha\\)</span>.</p>`;
const fullHtml = `<!doctype html><html><head><title>Unified research fixture</title></head><body><article>${article}</article></body></html>`;
const preview = '<html><head><title>Preview</title></head><body><article><h1>Preview</h1><p>This is a preview of subscription content</p></article></body></html>';
let directory;
let server;
let baseUrl;
let requests = 0;

before(async () => {
	const output = path.join(root, 'output/browser-fetch/tests');
	await mkdir(output, { recursive: true });
	directory = await mkdtemp(path.join(output, 'unified-'));
	server = createServer((request, response) => {
		requests++;
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		if (request.url === '/article') response.end(fullHtml);
		else if (request.url === '/preview') response.end(preview);
		else if (request.url === '/with-images') response.end(fullHtml.replace('</article>', '<figure><img src="https://user:secret@images.example/figure.png" alt="Figure 1"><figcaption>Research figure caption.</figcaption></figure></article>'));
		else if (request.url === '/short') response.end('<html><body><article><h1>Short paper</h1><p>Not enough body text.</p></article></body></html>');
		else if (request.url === '/challenge') response.end(fullHtml.replace('<title>Unified research fixture</title>', '<title>Just a moment...</title>'));
		else if (request.url === '/dynamic') response.end(preview.replace('</body>', `<script>setTimeout(() => {
			document.title = 'Unified research fixture'; document.querySelector('article').innerHTML = ${JSON.stringify(article)};
		}, 250);</script></body>`));
		else response.writeHead(Number(request.url?.slice(1)) || 404).end('Unavailable');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	server.closeAllConnections();
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function urlOptions(name, route = '/article', extra = []) {
	return parseOptions([`${baseUrl}${route}`, '-o', path.join(directory, name), '--fetch', 'http', ...extra]);
}

async function localFixture(name) {
	const input = path.join(directory, name, 'input');
	const output = path.join(directory, name, 'output');
	await mkdir(input, { recursive: true });
	return { input, output, options: extra => parseOptions([input, '-o', output, ...extra ?? []]) };
}

async function exportPair(input, name = 'paper.html', html = fullHtml) {
	const file = path.join(input, name);
	await writeFile(file, html, 'utf8');
	await writeFile(`${file}.json`, JSON.stringify({
		schemaVersion: 1, captureMethod: 'clipper-dom', title: 'Unified research fixture',
		url: `${baseUrl}/article`, capturedAt: '2026-10-07T12:44:23.964Z', charset: 'UTF-8',
		htmlFile: name, htmlBytes: Buffer.byteLength(html), status: 'unchecked',
	}));
	return file;
}

test('auto-detects URLs and local paths while forwarding shared and browser options', () => {
	const url = parseOptions(['https://example.com/paper', '--fetch', 'browser', '--profile', 'my profile',
		'--headed', '--wait-for', 'article', '--timeout', '9000', '--settle', '100',
		'--require-section', 'Results', '--require-section', 'Methods', '--min-words', '700', '-t', 'custom.json', '--overwrite']);
	assert.equal(url.route, 'url');
	assert.equal(url.config.mode, 'browser');
	assert.equal(url.config.profile, path.resolve('my profile'));
	assert.equal(url.config.headless, false);
	assert.equal(url.config.waitFor, 'article');
	assert.equal(url.config.timeout, 9000);
	assert.equal(url.config.settle, 100);
	assert.equal(url.config.minWords, 700);
	assert.equal(url.config.template, path.resolve('custom.json'));
	assert.equal(url.config.overwrite, true);
	assert.deepEqual(url.config.requiredSections, ['Results', 'Methods']);
	for (const input of ['E:\\Paper_Clipper', '/tmp/exports', './paper.html', 'paper with spaces.html']) {
		const local = parseOptions([input, '--timeout', '1', '-o', 'converted', '--require-section', 'Methods']);
		assert.equal(local.route, 'import');
		assert.equal(local.input, path.resolve(input));
		assert.equal(local.config.timeout, 1);
		assert.equal(local.outputDir, path.resolve('converted'));
		assert.deepEqual(local.config.requiredSections, ['Methods']);
	}
	assert.equal(parseOptions(['https://example.com']).config.mode, 'auto');
	assert.equal(parseOptions(['https://example.com', '--login']).config.mode, 'browser');
	assert.equal(parseOptions(['--', '--exports']).input, path.resolve('--exports'));
});

test('uses stable bounded URL filenames, distinguishes paths and queries, and ignores fragments', () => {
	const url = 'https://example.com/a/paper?version=1';
	const output = parseOptions([url]).config.output;
	assert.equal(parseOptions([`${url}#Methods`]).config.output, output);
	assert.notEqual(parseOptions(['https://example.com/b/paper?version=1']).config.output, output);
	assert.notEqual(parseOptions(['https://example.com/a/paper?version=2']).config.output, output);
	assert.match(path.basename(output), /^example.com-paper-[a-f0-9]{12}\.md$/);
	const long = parseOptions([`https://example.com/${'long%20name'.repeat(100)}`]);
	assert.ok(path.basename(long.config.output).length < 100);
	assert.ok(!/[<>:"/\\|?*]/.test(path.basename(long.config.output)));
	const exact = parseOptions([url, '--output', 'custom/paper.md']);
	assert.equal(exact.config.output, path.resolve('custom/paper.md'));
	assert.equal(exact.outputDir, path.resolve('custom'));
	assert.equal(parseOptions([url, '-o', 'custom']).outputDir, path.resolve('custom'));
});

test('rejects invalid input, mixed routes, credentials and conflicting destinations before I/O', () => {
	assert.deepEqual(parseOptions(['--help']), { help: true });
	for (const args of [[], [' '], ['one', 'two'], ['https://'], ['ftp://example.com/file'],
		['file:///tmp/paper.html'], ['javascript:alert(1)'], ['https://user:secret@example.com'],
		['https://example.com', '-o', ''], ['https://example.com', '--profile', ' '],
		['https://example.com', '--output', 'a.md', '-o', 'out'], ['https://example.com', '--output', 'a.txt'],
		['https://example.com', '--fetch', 'unknown'], ['file.html', '--html', 'other.html'],
		['file.html', '--fetch', 'auto'], ['folder', '--login'], ['folder', '--settle', '100'],
		['folder', '--output', 'a.md'], ['folder', '--require-section', ' '], ['folder', '--min-words', '0']]) {
		assert.throws(() => parseOptions(args), args.join(' '));
	}
});

test('asset flag reaches both routes; unresolved images retain Markdown and produce explicit recovery advice', { timeout: 30000 }, async () => {
	const options = urlOptions('assets-http', '/with-images', ['--download-assets']);
	assert.equal(options.config.downloadAssets, true);
	const result = await clip(options);
	assert.equal(result.exitCode, 0);
	const item = result.report.items[0];
	assert.equal(item.outputWritten, true);
	assert.equal(item.assets.failed, 1);
	assert.equal(item.assets.status, 'partial');
	assert.equal(item.nextStep.code, 'review-assets');
	assert.match(await readFile(item.output, 'utf8'), /user:secret@images\.example/);
	assert.equal(JSON.parse(await readFile(item.paperReport, 'utf8')).assets.failed, 1);
	const messages = [];
	printResult(result, message => messages.push(message));
	assert.ok(messages.some(message => message.includes('1 unresolved')));
	const before = requests;
	const skipped = await clip(options);
	assert.equal(skipped.report.items[0].status, 'skipped');
	assert.equal(requests, before);
	const fixture = await localFixture('assets-import');
	await exportPair(fixture.input, 'paper.html', fullHtml.replace('</article>', '<img src="http://127.0.0.1:1/figure.png" alt="Figure"></article>'));
	const config = fixture.options(['--download-assets']);
	assert.equal(config.config.downloadAssets, true);
	const imported = await clip(config);
	assert.equal(imported.exitCode, 0);
	assert.equal(imported.report.items[0].assets.failed, 1);
	assert.equal(imported.report.items[0].nextStep.code, 'review-assets');
	assert.equal(requests, before);
	const noFlag = await clip(fixture.options(['--overwrite']));
	assert.equal(noFlag.report.items[0].assets, undefined);
	assert.equal(requests, before);
	const rejected = await clip(urlOptions('assets-rejected', '/preview', ['--download-assets']));
	assert.equal(rejected.exitCode, 2);
	assert.equal(rejected.report.items[0].assets, undefined);
});

test('URL conversion produces unified success, immutable diagnostics, formulas and review guidance', { timeout: 15000 }, async () => {
	const options = urlOptions('http', '/article', ['--require-section', 'Methods']);
	const result = await clip(options);
	assert.equal(result.exitCode, 0);
	assert.equal(result.report.route, 'url');
	assert.deepEqual(result.report.counts, { success: 1, incomplete: 0, failed: 0, skipped: 0 });
	const item = result.report.items[0];
	assert.equal(item.status, 'success');
	assert.equal(item.outputWritten, true);
	assert.equal(item.nextStep.code, 'review-markdown');
	assert.ok(item.quality.passed);
	assert.equal(item.normalizations.mathJaxTex, 1);
	assert.equal(item.paperReport, path.join(item.artifactDirectory, 'report.json'));
	const markdown = await readFile(item.output, 'utf8');
	assert.ok(markdown.includes(String.raw`$x_i + \alpha$`));
	assert.ok(markdown.includes(`${baseUrl}/figures/1`));
	assert.deepEqual(JSON.parse(await readFile(result.reportPath, 'utf8')), result.report);
	const paperReport = JSON.parse(await readFile(item.paperReport, 'utf8'));
	assert.deepEqual(paperReport.attempts.map(attempt => attempt.mode), ['http']);
	assert.deepEqual(paperReport.checks.requiredSections, ['Methods']);
});

test('repeat URL skips without any network/browser request or changes to earlier results', { timeout: 15000 }, async () => {
	const options = urlOptions('repeat');
	const first = await clip(options);
	const item = first.report.items[0];
	const paths = [item.output, `${item.output}.report.json`, item.paperReport, first.reportPath];
	const originals = [];
	for (const file of paths) originals.push({ bytes: await readFile(file), mtime: (await stat(file)).mtimeMs });
	const before = requests;
	const second = await clip(parseOptions([`${baseUrl}/article`, '-o', options.outputDir]));
	assert.equal(requests, before);
	assert.equal(second.exitCode, 0);
	assert.equal(second.report.counts.skipped, 1);
	assert.equal(second.report.items[0].reason, 'output-exists');
	assert.equal(second.report.items[0].nextStep.code, 'review-existing');
	assert.equal(second.report.items[0].outputWritten, false);
	assert.notEqual(second.reportPath, first.reportPath);
	for (const [index, file] of paths.entries()) {
		assert.deepEqual(await readFile(file), originals[index].bytes);
		assert.equal((await stat(file)).mtimeMs, originals[index].mtime);
	}
});

test('preview overwrite keeps accepted Markdown, reports incomplete and suggests authorized export', { timeout: 15000 }, async () => {
	const output = path.join(directory, 'overwrite', 'paper.md');
	await mkdir(path.dirname(output), { recursive: true });
	await writeFile(output, 'Previously accepted paper');
	const options = parseOptions([`${baseUrl}/preview`, '--output', output, '--fetch', 'http', '--overwrite']);
	const result = await clip(options);
	assert.equal(result.exitCode, 2);
	assert.equal(result.report.counts.incomplete, 1);
	assert.equal(result.report.items[0].nextStep.code, 'export-authorized-tab');
	assert.equal(result.report.items[0].outputWritten, false);
	assert.equal(await readFile(output, 'utf8'), 'Previously accepted paper');
	const accepted = await clip(parseOptions([`${baseUrl}/article`, '--output', output, '--fetch', 'http', '--overwrite']));
	assert.equal(accepted.exitCode, 0);
	assert.match(await readFile(output, 'utf8'), /## Methods/);
	const lines = [];
	printResult(result, line => lines.push(line));
	assert.ok(lines.some(line => line.includes('Destination (not written)')));
	assert.ok(!lines.some(line => line.includes('  Markdown:')));
	assert.ok(lines.some(line => line.includes('npm run clip --')));
});

test('access errors, challenges, ordinary HTTP failures and short content get distinct guidance', { timeout: 20000 }, async () => {
	for (const code of [401, 403, 404]) {
		const result = await clip(urlOptions(`error-${code}`, `/${code}`));
		assert.equal(result.exitCode, 1);
		assert.equal(result.report.counts.failed, 1);
		assert.equal(result.report.items[0].nextStep.code, code === 404 ? 'inspect-error' : 'export-authorized-tab');
		await assert.rejects(stat(result.report.items[0].output), { code: 'ENOENT' });
	}
	const challenge = await clip(urlOptions('challenge', '/challenge'));
	assert.equal(challenge.exitCode, 2);
	assert.equal(challenge.report.items[0].nextStep.code, 'export-authorized-tab');
	const short = await clip(urlOptions('short', '/short'));
	assert.equal(short.exitCode, 2);
	assert.equal(short.report.items[0].nextStep.code, 'inspect-content');
});

test('auto route still falls back to a rendered browser page and suppresses stale access advice on success', { timeout: 20000 }, async () => {
	const options = parseOptions([`${baseUrl}/dynamic`, '-o', path.join(directory, 'dynamic'),
		'--profile', path.join(directory, 'profile'), '--timeout', '10000', '--settle', '600']);
	const result = await clip(options);
	assert.equal(result.exitCode, 0);
	const item = result.report.items[0];
	const paper = JSON.parse(await readFile(item.paperReport, 'utf8'));
	assert.deepEqual(paper.attempts.map(attempt => [attempt.mode, attempt.status]), [['http', 'incomplete'], ['browser', 'passed-checks']]);
	assert.equal(item.nextStep.code, 'review-markdown');
	assert.equal(item.error, undefined);
	assert.equal(item.accessLimited, undefined);
	assert.match(await readFile(item.output, 'utf8'), /## Methods/);
});

test('single export routes offline, reads its URL and keeps original files and normalization', { timeout: 15000 }, async () => {
	const setup = await localFixture('single');
	const file = await exportPair(setup.input, 'paper with spaces.html');
	const before = requests;
	const html = await readFile(file);
	const metadata = await readFile(`${file}.json`);
	const result = await clip(parseOptions([file, '-o', setup.output, '--require-section', 'Methods']));
	assert.equal(result.exitCode, 0);
	assert.equal(result.report.route, 'import');
	assert.equal(result.report.counts.success, 1);
	assert.equal(result.report.items[0].url, `${baseUrl}/article`);
	assert.equal(result.report.items[0].normalizations.mathJaxTex, 1);
	assert.equal(result.report.items[0].nextStep.code, 'review-markdown');
	assert.deepEqual(await readFile(file), html);
	assert.deepEqual(await readFile(`${file}.json`), metadata);
	const paper = JSON.parse(await readFile(result.report.items[0].paperReport, 'utf8'));
	assert.equal(paper.mode, 'file');
	const batch = JSON.parse(await readFile(result.report.sourceReport, 'utf8'));
	assert.deepEqual(batch.counts, result.report.counts);
	const again = await clip(setup.options());
	assert.equal(again.report.counts.skipped, 1);
	assert.equal(again.report.items[0].nextStep.code, 'review-existing');
	assert.equal(requests, before);
});

test('batch imports share status vocabulary and aggregate failures without stopping later papers', { timeout: 20000 }, async () => {
	const setup = await localFixture('batch');
	await writeFile(path.join(setup.input, 'a-missing.html'), fullHtml);
	await exportPair(setup.input, 'b-preview.html', preview);
	await exportPair(setup.input, 'c-full.html');
	await mkdir(path.join(setup.input, 'nested'));
	await exportPair(path.join(setup.input, 'nested'), 'ignored.html');
	const before = requests;
	const result = await clip(setup.options());
	assert.equal(result.exitCode, 1);
	assert.equal(result.report.status, 'completed-with-issues');
	assert.deepEqual(result.report.counts, { success: 1, incomplete: 1, failed: 1, skipped: 0 });
	assert.deepEqual(result.report.items.map(item => item.nextStep.code), ['repair-export-pair', 'export-authorized-tab', 'review-markdown']);
	assert.equal(requests, before);
	const lines = [];
	printResult(result, line => lines.push(line));
	assert.ok(lines.some(line => line.startsWith('[failed]')));
	assert.ok(lines.some(line => line.startsWith('[incomplete]')));
	assert.ok(lines.some(line => line.startsWith('[success]')));
	assert.ok(lines.some(line => line.startsWith('  Checks: subscription-preview')));
	assert.ok(lines.some(line => line === 'Summary: success=1, incomplete=1, failed=1, skipped=0'));
});

test('local required sections and custom templates are not lost at the unified boundary', { timeout: 20000 }, async () => {
	const setup = await localFixture('custom');
	await exportPair(setup.input);
	const template = path.join(directory, 'template.json');
	await writeFile(template, JSON.stringify({ noteNameFormat: '{{title}}', noteContentFormat: 'Custom: {{title}}', properties: [] }));
	const rejected = await clip(setup.options(['-t', template, '--require-section', 'Discussion']));
	assert.equal(rejected.exitCode, 2);
	assert.equal(rejected.report.items[0].nextStep.code, 'inspect-content');
	assert.ok(rejected.report.items[0].quality.reasons.includes('missing-section:Discussion'));
	const lossy = await clip(setup.options(['-t', template, '--require-section', 'Methods']));
	assert.equal(lossy.exitCode, 2);
	assert.ok(lossy.report.items[0].quality.reasons.includes('output-missing-section:Methods'));
	await writeFile(template, JSON.stringify({ noteNameFormat: '{{title}}', noteContentFormat: 'Custom: {{title}}\n\n{{content}}', properties: [] }));
	const accepted = await clip(setup.options(['-t', template, '--require-section', 'Methods']));
	assert.equal(accepted.exitCode, 0);
	assert.match(await readFile(accepted.report.items[0].output, 'utf8'), /Custom: Unified research fixture/);
});

test('empty inputs, inaccessible paths, missing templates and destination conflicts have useful reports', { timeout: 15000 }, async () => {
	const setup = await localFixture('empty');
	const empty = await clip(setup.options());
	assert.equal(empty.exitCode, 1);
	assert.equal(empty.report.status, 'empty');
	assert.equal(empty.report.nextStep.code, 'provide-export-pairs');
	assert.equal(empty.report.items.length, 0);
	const missing = await clip(parseOptions([path.join(setup.input, 'missing'), '-o', setup.output]));
	assert.equal(missing.exitCode, 1);
	assert.equal(missing.report.counts.failed, 1);
	assert.match(missing.report.items[0].error, /ENOENT/);
	const template = await clip(urlOptions('missing-template', '/article', ['-t', path.join(directory, 'absent.json')]));
	assert.equal(template.exitCode, 1);
	assert.equal(template.report.items[0].nextStep.code, 'inspect-error');
	const conflict = urlOptions('conflict');
	await mkdir(conflict.config.output, { recursive: true });
	const before = requests;
	const result = await clip(conflict);
	assert.equal(result.exitCode, 1);
	assert.match(result.report.items[0].error, /not a regular file/);
	assert.equal(requests, before);
	assert.ok((await stat(conflict.config.output)).isDirectory());
});

test('CLI help and exit codes work through the public entry point', { timeout: 20000 }, async () => {
	const entry = path.join(root, 'scripts/clip.mjs');
	const help = await run(process.execPath, [entry, '--help'], { windowsHide: true });
	assert.match(help.stdout, /url \| file.html \| directory/);
	const output = path.join(directory, 'cli');
	const success = await run(process.execPath, [entry, `${baseUrl}/article`, '-o', output, '--fetch', 'http'], { windowsHide: true });
	assert.match(success.stdout, /success=1, incomplete=0, failed=0, skipped=0/);
	const skipped = await run(process.execPath, [entry, `${baseUrl}/article`, '-o', output], { windowsHide: true });
	assert.match(skipped.stdout, /skipped=1/);
	await assert.rejects(run(process.execPath, [entry, `${baseUrl}/preview`, '-o', output, '--fetch', 'http'], { windowsHide: true }),
		error => error.code === 2 && /incomplete=1/.test(error.stdout) && /Export page HTML/.test(error.stdout));
	await assert.rejects(run(process.execPath, [entry, 'ftp://example.com/file'], { windowsHide: true }),
		error => error.code === 1 && /HTTP\(S\)/.test(error.stderr));
});

test('missing rendered equations get a specific recovery step', () => {
	const step = nextStep({ status: 'incomplete', quality: { reasons: ['unrendered-equations'] } }, 'url');
	assert.equal(step.code, 'render-equations');
	assert.match(step.message, /browser rendering/);
});
