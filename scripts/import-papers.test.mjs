import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { importPapers, parseOptions, readExportPair } from './import-papers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const paragraph = 'This research compares tissue expression and spatial organization across biological samples. '.repeat(80);
const fullHtml = `<!doctype html><html><head><title>Imported research fixture</title></head><body><article>
	<h1>Imported research fixture</h1><h2>Results</h2><p>${paragraph}</p><h2>Methods</h2><p>${paragraph}</p>
	<p><a href="/figures/1">Figure 1</a><img src="/image.png" alt="Figure 1"></p>
	<p>Inline <span class="mathjax-tex">\\(x_i + \\alpha\\)</span> is preserved.</p>
	<div class="mathjax-tex">$$\\frac{x_i}{y_j}$$</div></article></body></html>`;
const previewHtml = '<html><head><title>Preview</title></head><body><article><h1>Preview</h1><p>This is a preview of subscription content</p></article></body></html>';
let directory;
let server;
let baseUrl;
let requests = 0;

before(async () => {
	const output = path.join(root, 'output/browser-fetch/tests');
	await mkdir(output, { recursive: true });
	directory = await mkdtemp(path.join(output, 'import-'));
	server = createServer((_request, response) => {
		requests++;
		response.writeHead(500).end('Imports must not request article or resource URLs.');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	server.closeAllConnections();
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function fixture(name) {
	const input = path.join(directory, name, 'input');
	const output = path.join(directory, name, 'output');
	await mkdir(input, { recursive: true });
	return { input, output, options: extra => parseOptions([input, '-o', output, ...extra ?? []]) };
}

async function exportPair(input, name = 'paper.html', html = fullHtml, overrides = {}) {
	const file = path.join(input, name);
	const metadata = {
		schemaVersion: 1, captureMethod: 'clipper-dom', extensionVersion: '1.7.1',
		sourceUrl: `${baseUrl}/article`, url: `${baseUrl}/article`, baseURI: `${baseUrl}/article`,
		title: 'Imported research fixture', capturedAt: '2026-10-07T12:44:23.964Z',
		charset: 'UTF-8', htmlFile: name, htmlBytes: Buffer.byteLength(html), status: 'unchecked',
		...overrides,
	};
	await writeFile(file, html);
	await writeFile(`${file}.json`, JSON.stringify(metadata));
	return { file, metadata };
}

test('validates arguments, preserves paths with spaces, and accepts conversion timeouts below browser settle time', () => {
	assert.deepEqual(parseOptions(['--help']), { help: true });
	for (const args of [[], [''], ['one', 'two'], ['one', '--fetch', 'browser'], ['one', '-o', ''],
		['one', '-t', ' '], ['one', '--require-section', ' '], ['one', '--min-words', '0'],
		['one', '--min-words', '1.2'], ['one', '--timeout', 'NaN'], ['one', '--timeout', '2147483648']]) {
		assert.throws(() => parseOptions(args));
	}
	const config = parseOptions(['a file.html', '--timeout', '1', '--require-section', ' Results ', '--require-section', 'Methods']);
	assert.equal(config.input, path.resolve('a file.html'));
	assert.equal(config.timeout, 1);
	assert.equal(config.overwrite, false);
	assert.equal(config.minWords, 1000);
	assert.deepEqual(config.requiredSections, ['Results', 'Methods']);
});

test('validates metadata, filenames, size and encoding before conversion', async () => {
	const setup = await fixture('validation');
	const invalid = [
		[{ schemaVersion: 2 }, /schemaVersion/],
		[{ captureMethod: 'http' }, /captureMethod/],
		[{ url: null }, /page URL/],
		[{ url: 'not a URL' }, /invalid page URL/],
		[{ url: 'file:///private' }, /HTTP\(S\)/],
		[{ url: 'https://user:password@example.com' }, /credentials/],
		[{ title: null }, /title/],
		[{ capturedAt: 'invalid' }, /timestamp/],
		[{ charset: 'UTF-16' }, /UTF-8/],
		[{ htmlFile: '../other.html' }, /filename/],
		[{ htmlBytes: 0 }, /htmlBytes/],
		[{ htmlBytes: 31 * 1024 * 1024 }, /htmlBytes/],
		[{ htmlBytes: 42 }, /size mismatch/],
	];
	for (const [index, [metadata, expected]] of invalid.entries()) {
		const { file } = await exportPair(setup.input, `invalid-${index}.html`, fullHtml, metadata);
		await assert.rejects(readExportPair(file), expected);
	}
	const badEncoding = await exportPair(setup.input, 'encoding.html', Buffer.from([0xff, 0xfe]));
	await assert.rejects(readExportPair(badEncoding.file), /not valid UTF-8/);
	const large = await exportPair(setup.input, 'large-json.html');
	await writeFile(`${large.file}.json`, ' '.repeat(65537));
	await assert.rejects(readExportPair(large.file), /byte limit/);
	const bom = await exportPair(setup.input, 'bom.html', '\uFEFF' + fullHtml);
	await writeFile(`${bom.file}.json`, '\uFEFF' + JSON.stringify(bom.metadata));
	assert.equal((await readExportPair(bom.file)).html.length, bom.metadata.htmlBytes);
});

test('imports a single pair offline with real CLI math, quality and immutable source copies', { timeout: 15000 }, async () => {
	const setup = await fixture('single');
	const { file } = await exportPair(setup.input, 'paper with spaces.html');
	const html = await readFile(file);
	const json = await readFile(`${file}.json`);
	const count = requests;
	const result = await importPapers(parseOptions([file, '-o', setup.output, '--require-section', 'Methods']));
	assert.equal(result.exitCode, 0);
	assert.deepEqual(result.report.counts, { success: 1, incomplete: 0, failed: 0, skipped: 0 });
	const item = result.report.items[0];
	assert.equal(item.url, `${baseUrl}/article`);
	assert.equal(item.outputWritten, true);
	assert.equal(item.normalizations.mathJaxTex, 2);
	assert.ok(item.quality.passed);
	assert.ok(item.quality.wordsBeforeReferences > 1000);
	assert.equal(item.paperReport, path.join(item.artifactDirectory, 'report.json'));
	const paperReport = JSON.parse(await readFile(item.paperReport, 'utf8'));
	assert.equal(paperReport.mode, 'file');
	assert.equal(paperReport.capturedAt, '2026-10-07T12:44:23.964Z');
	assert.equal(paperReport.attempts.length, 1);
	assert.deepEqual(paperReport.checks.requiredSections, ['Methods']);
	assert.deepEqual(await readFile(file), html);
	assert.deepEqual(await readFile(`${file}.json`), json);
	assert.deepEqual(await readFile(item.snapshotHtml), html);
	assert.deepEqual(await readFile(`${item.snapshotHtml}.json`), json);
	const markdown = await readFile(item.output, 'utf8');
	assert.ok(markdown.includes(String.raw`$x_i + \alpha$`));
	assert.ok(markdown.includes('$$\n' + String.raw`\frac{x_i}{y_j}` + '\n$$'));
	assert.ok(markdown.includes(`${baseUrl}/figures/1`));
	assert.equal(requests, count);
	assert.deepEqual(JSON.parse(await readFile(result.reportPath, 'utf8')), result.report);
});

test('mixed top-level directory continues after failures and reports orphaned sidecars', { timeout: 20000 }, async () => {
	const setup = await fixture('mixed');
	const invalid = await exportPair(setup.input, 'a-bad-json.html');
	await writeFile(`${invalid.file}.json`, '{broken');
	await writeFile(path.join(setup.input, 'b-missing-json.html'), fullHtml);
	await writeFile(path.join(setup.input, 'c-missing-html.html.json'), JSON.stringify({
		...invalid.metadata, htmlFile: 'c-missing-html.html',
	}));
	await exportPair(setup.input, 'd-preview.html', previewHtml);
	await exportPair(setup.input, 'e-full.html');
	await writeFile(path.join(setup.input, 'notes.txt'), 'ignored');
	await mkdir(path.join(setup.input, 'nested'));
	await exportPair(path.join(setup.input, 'nested'));
	const { exitCode, report } = await importPapers(setup.options());
	assert.equal(exitCode, 1);
	assert.equal(report.status, 'completed-with-issues');
	assert.equal(report.discovered, 5);
	assert.deepEqual(report.counts, { success: 1, incomplete: 1, failed: 3, skipped: 0 });
	assert.deepEqual(report.items.map(item => item.status), ['failed', 'failed', 'failed', 'incomplete', 'success']);
	assert.match(report.items[0].error, /Invalid companion JSON/);
	assert.match(report.items[1].error, /Missing companion JSON/);
	assert.match(report.items[2].error, /Missing HTML file/);
	assert.ok(report.items[3].quality.reasons.includes('subscription-preview'));
	assert.equal(report.items[3].outputWritten, false);
	await assert.rejects(stat(report.items[3].output), { code: 'ENOENT' });
	assert.equal(requests, 0);
});

test('repeated import skips outputs without changing Markdown or prior reports', { timeout: 15000 }, async () => {
	const setup = await fixture('repeat');
	await exportPair(setup.input);
	const first = await importPapers(setup.options());
	const output = first.report.items[0].output;
	const paths = [output, `${output}.report.json`, first.report.items[0].paperReport, first.reportPath];
	const originals = [];
	for (const file of paths) originals.push({ bytes: await readFile(file), mtime: (await stat(file)).mtimeMs });
	const second = await importPapers(setup.options());
	assert.equal(second.exitCode, 0);
	assert.notEqual(second.reportPath, first.reportPath);
	assert.deepEqual(second.report.counts, { success: 0, incomplete: 0, failed: 0, skipped: 1 });
	assert.equal(second.report.items[0].reason, 'output-exists');
	assert.equal(second.report.items[0].outputWritten, false);
	assert.equal(second.report.items[0].snapshotHtml, undefined);
	for (const [index, file] of paths.entries()) {
		assert.deepEqual(await readFile(file), originals[index].bytes);
		assert.equal((await stat(file)).mtimeMs, originals[index].mtime);
	}
});

test('overwrite rejects incomplete content without replacing accepted output, then allows good replacement', { timeout: 20000 }, async () => {
	const setup = await fixture('overwrite');
	await exportPair(setup.input, 'paper.html', previewHtml);
	await mkdir(setup.output);
	const output = path.join(setup.output, 'paper.md');
	await writeFile(output, 'Previously accepted paper');
	const rejected = await importPapers(setup.options(['--overwrite']));
	assert.equal(rejected.exitCode, 2);
	assert.equal(await readFile(output, 'utf8'), 'Previously accepted paper');
	const oldReport = await readFile(rejected.report.items[0].paperReport);
	await exportPair(setup.input);
	const accepted = await importPapers(setup.options(['--overwrite']));
	assert.equal(accepted.exitCode, 0);
	assert.match(await readFile(output, 'utf8'), /## Methods/);
	assert.deepEqual(await readFile(rejected.report.items[0].paperReport), oldReport);
});

test('existing output directories are failures, never overwritten or treated as skips', async () => {
	const setup = await fixture('conflict');
	await exportPair(setup.input);
	await mkdir(path.join(setup.output, 'paper.md'), { recursive: true });
	const result = await importPapers(setup.options(['--overwrite']));
	assert.equal(result.exitCode, 1);
	assert.match(result.report.items[0].error, /not a regular file/);
	assert.ok((await stat(path.join(setup.output, 'paper.md'))).isDirectory());
});

test('custom templates and required sections are forwarded without bypassing body checks', { timeout: 25000 }, async () => {
	const setup = await fixture('custom');
	await exportPair(setup.input);
	const template = path.join(directory, 'template.json');
	await writeFile(template, JSON.stringify({ noteNameFormat: '{{title}}', noteContentFormat: 'Custom: {{title}}', properties: [] }));
	const rejected = await importPapers(setup.options(['-t', template, '--require-section', 'Discussion']));
	assert.equal(rejected.exitCode, 2);
	assert.ok(rejected.report.items[0].quality.reasons.includes('missing-section:Discussion'));
	await assert.rejects(stat(rejected.report.items[0].output), { code: 'ENOENT' });
	const lossy = await importPapers(setup.options(['-t', template, '--require-section', 'Methods']));
	assert.equal(lossy.exitCode, 2);
	assert.ok(lossy.report.items[0].quality.reasons.includes('output-missing-section:Methods'));
	await writeFile(template, JSON.stringify({ noteNameFormat: '{{title}}', noteContentFormat: 'Custom: {{title}}\n\n{{content}}', properties: [] }));
	const accepted = await importPapers(setup.options(['-t', template, '--require-section', 'Methods']));
	assert.equal(accepted.exitCode, 0);
	assert.match(await readFile(accepted.report.items[0].output, 'utf8'), /Custom: Imported research fixture/);
	assert.ok(accepted.report.items[0].quality.wordsBeforeReferences > 1000);
});

test('conversion failures and timeouts become failed items with diagnostics', { timeout: 10000 }, async () => {
	const setup = await fixture('timeout');
	await exportPair(setup.input);
	const result = await importPapers(setup.options(['--timeout', '1']));
	assert.equal(result.exitCode, 1);
	assert.equal(result.report.counts.failed, 1);
	assert.match(result.report.items[0].error, /conversion failed/);
	assert.equal(result.report.items[0].outputWritten, false);
	assert.ok((await stat(result.report.items[0].snapshotHtml)).isFile());
});

test('empty directory produces an explicit report; invalid input and template fail before importing', async () => {
	const setup = await fixture('empty');
	const result = await importPapers(setup.options());
	assert.equal(result.exitCode, 1);
	assert.equal(result.report.status, 'empty');
	assert.match(result.report.error, /No HTML exports/);
	const file = path.join(setup.input, 'notes.txt');
	await writeFile(file, 'Not HTML');
	await assert.rejects(importPapers({ ...setup.options(), input: file }), /end in .html/);
	await assert.rejects(importPapers({ ...setup.options(), template: path.join(directory, 'missing-template.json') }), { code: 'ENOENT' });
});

test('command-line entry point returns success, incomplete and failed exit codes', { timeout: 20000 }, async () => {
	const setup = await fixture('cli');
	const full = await exportPair(setup.input, 'full.html');
	const preview = await exportPair(setup.input, 'preview.html', previewHtml);
	const missing = path.join(setup.input, 'missing-json.html');
	await writeFile(missing, fullHtml);
	const args = file => [path.join(root, 'scripts/import-papers.mjs'), file, '-o', setup.output];
	const success = await run(process.execPath, args(full.file), { windowsHide: true });
	assert.match(success.stdout, /success=1, incomplete=0, failed=0, skipped=0/);
	await assert.rejects(run(process.execPath, args(preview.file), { windowsHide: true }), error => error.code === 2 && /incomplete=1/.test(error.stdout));
	await assert.rejects(run(process.execPath, args(missing), { windowsHide: true }), error => error.code === 1 && /failed=1/.test(error.stdout));
	assert.equal(requests, 0);
});
