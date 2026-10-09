import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { clip, parseOptions, printResult } from './clip.mjs';
import { splitFrontmatter } from './archive-papers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const paragraph = 'This study compares expression measurements across tissue samples with validated experimental observations. '.repeat(90);
const full = `<html><head><title>Unified Vault fixture</title><meta name="citation_title" content="Unified Vault fixture"><meta name="citation_doi" content="10.1234/unified-vault"></head><body><article><h1>Unified Vault fixture</h1><h2>Results</h2><p>${paragraph}</p><h2>Methods</h2><p>${paragraph}</p><p><span class="mathjax-tex">\\(x_i + \\alpha\\)</span></p></article></body></html>`;
const preview = '<html><head><title>Preview</title></head><body><article><h1>Preview</h1><p>This is a preview of subscription content.</p></article></body></html>';
const withImages = full.replace('</article>', '<figure><img src="http://127.0.0.1:1/figure.png" alt="Figure"><figcaption>Image caption</figcaption></figure></article>');
let directory;
let server;
let baseUrl;
let requests = 0;

before(async () => {
	await mkdir(path.join(root, 'output/browser-fetch/tests'), { recursive: true });
	directory = await mkdtemp(path.join(root, 'output/browser-fetch/tests/clip-vault-'));
	server = createServer((request, response) => {
		requests++;
		response.setHeader('Content-Type', 'text/html');
		response.end(request.url === '/preview' ? preview : request.url === '/images' ? withImages : full);
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
});

function setup(name, route = '/article', extra = []) {
	const output = path.join(directory, name, 'converted');
	const vault = path.join(directory, name, 'Vault');
	return { output, vault, options: parseOptions([baseUrl + route, '-o', output, '--vault', vault, '--fetch', 'http', ...extra]) };
}

async function exportPair(folder, name, html = full, url = baseUrl + '/article') {
	await mkdir(folder, { recursive: true });
	const input = path.join(folder, name);
	await writeFile(input, html);
	await writeFile(`${input}.json`, JSON.stringify({ schemaVersion: 1, captureMethod: 'clipper-dom', title: 'Fixture',
		url, capturedAt: '2026-10-07T12:44:00.000Z', charset: 'UTF-8', htmlFile: name, htmlBytes: Buffer.byteLength(html) }));
	return input;
}

test('vault flags work on both routes without implicitly enabling network or overwrite', () => {
	for (const input of ['https://example.com/paper', 'exports']) {
		const options = parseOptions([input, '--vault', path.join(directory, 'options/Vault'), '-o', path.join(directory, 'options/converted'), '--papers-dir', 'Research/Papers']);
		assert.equal(options.archive.papersDir, path.join(directory, 'options/Vault/Research/Papers'));
		assert.equal(options.config.downloadAssets, false);
		assert.equal(options.config.overwrite, false);
	}
	assert.equal(parseOptions(['https://example.com']).archive, undefined);
	for (const extra of [['--vault', ' '], ['--papers-dir', 'Papers'], ['--vault', 'Vault', '--papers-dir', '../outside'], ['--vault', 'Vault', '--dry-run']]) {
		assert.throws(() => parseOptions(['https://example.com', ...extra]));
	}
	assert.throws(() => parseOptions(['https://example.com', '--vault', path.join(directory, 'bad-vault'), '-o', path.join(directory, 'bad-vault/Papers'), '--overwrite']), /outside/);
});

test('URL conversion archives once; repeat reuses cache, skips the Vault duplicate and preserves annotations', { timeout: 20000 }, async () => {
	const s = setup('url', '/article', ['--download-assets', '--papers-dir', 'Reading/Papers']);
	const first = await clip(s.options);
	assert.equal(first.exitCode, 0);
	assert.deepEqual(first.report.archive.counts, { archived: 1, duplicate: 0, blocked: 0, failed: 0 });
	const item = first.report.items[0];
	assert.equal(item.status, 'success');
	assert.equal(item.archive.status, 'archived');
	assert.equal(item.nextStep.code, 'read-vault-note');
	assert.equal(splitFrontmatter(await readFile(item.archive.output, 'utf8')).body, splitFrontmatter(await readFile(item.output, 'utf8')).body);
	const annotated = await readFile(item.archive.output, 'utf8') + '\n## My annotations\n\nPreserve this.\n';
	await writeFile(item.archive.output, annotated);
	const before = requests;
	const timestamp = (await stat(item.archive.output)).mtimeMs;
	const second = await clip(s.options);
	assert.equal(second.exitCode, 0);
	assert.equal(second.report.items[0].status, 'skipped');
	assert.equal(second.report.items[0].archive.status, 'duplicate');
	assert.equal(second.report.items[0].nextStep.code, 'review-vault-existing');
	assert.equal(requests, before);
	assert.equal((await stat(item.archive.output)).mtimeMs, timestamp);
	assert.equal(await readFile(item.archive.output, 'utf8'), annotated);
	const lines = [];
	printResult(second, text => lines.push(text));
	assert.ok(lines.some(line => line.includes('Vault summary: archived=0, duplicate=1')));
	assert.ok(lines.some(line => line.includes(`Vault note: ${item.archive.output}`)));
	assert.deepEqual(JSON.parse(await readFile(second.reportPath, 'utf8')), second.report);
	const overwritten = await clip(parseOptions([baseUrl + '/article', '-o', s.output, '--vault', s.vault, '--fetch', 'http', '--overwrite']));
	assert.equal(overwritten.report.items[0].archive.status, 'duplicate');
	assert.equal(await readFile(item.archive.output, 'utf8'), annotated);
	assert.equal((await stat(item.archive.output)).mtimeMs, timestamp);
});

test('validated HTML imports archive offline and preserve capture metadata', { timeout: 15000 }, async () => {
	const s = setup('local');
	const input = await exportPair(path.join(directory, 'local/input'), 'paper.html');
	const before = requests;
	const result = await clip(parseOptions([input, '-o', s.output, '--vault', s.vault]));
	assert.equal(result.exitCode, 0);
	assert.equal(result.report.archive.counts.archived, 1);
	assert.equal(result.report.items[0].archive.metadata.captured_at, '2026-10-07T12:44:00.000Z');
	assert.equal(requests, before);
	assert.ok(result.report.sourceReport);
	assert.ok(result.report.archive.reportPath);
});

test('mixed batch archives valid papers only and continues after conversion and identity conflicts', { timeout: 20000 }, async () => {
	const s = setup('mixed');
	const input = path.join(directory, 'mixed/input');
	await exportPair(input, 'a-preview.html', preview);
	await exportPair(input, 'b-conflict.html');
	await exportPair(input, 'c-valid.html', full.replace('10.1234/unified-vault', '10.1234/second'), baseUrl + '/second');
	await writeFile(path.join(input, 'd-orphan.html'), full);
	await mkdir(s.vault, { recursive: true });
	await writeFile(path.join(s.vault, 'existing.md'), `---\ndoi: 10.1234/different\nsource: ${baseUrl}/article\n---\nUser note.\n`);
	const result = await clip(parseOptions([input, '-o', s.output, '--vault', s.vault]));
	assert.equal(result.exitCode, 1);
	assert.deepEqual(result.report.counts, { success: 2, incomplete: 1, failed: 1, skipped: 0 });
	assert.deepEqual(result.report.archive.counts, { archived: 1, duplicate: 0, blocked: 2, failed: 1 });
	assert.equal(result.report.items[0].nextStep.code, 'export-authorized-tab');
	assert.equal(result.report.items[1].nextStep.code, 'inspect-vault-error');
	assert.equal(result.report.items[2].nextStep.code, 'read-vault-note');
	assert.equal(result.report.items[3].nextStep.code, 'repair-export-pair');
});

test('incomplete pages keep exit 2 and never fall back to archiving old accepted outputs', { timeout: 15000 }, async () => {
	const s = setup('rejected-overwrite');
	const first = await clip(s.options);
	const oldNote = first.report.items[0].archive.output;
	const bytes = await readFile(oldNote);
	const result = await clip(parseOptions([baseUrl + '/preview', '--output', s.options.config.output, '--fetch', 'http', '--vault', s.vault, '--overwrite']));
	assert.equal(result.exitCode, 2);
	assert.equal(result.report.items[0].status, 'incomplete');
	assert.deepEqual(result.report.archive.counts, { archived: 0, duplicate: 0, blocked: 1, failed: 0 });
	assert.equal(result.report.archive.reportPath, undefined);
	assert.deepEqual(await readFile(oldNote), bytes);
});

test('unresolved images keep conversion artifacts but make vault workflow fail with repair advice', { timeout: 20000 }, async () => {
	const s = setup('partial-images', '/images', ['--download-assets']);
	const first = await clip(s.options);
	assert.equal(first.exitCode, 1);
	assert.equal(first.report.items[0].status, 'success');
	assert.equal(first.report.items[0].archive.status, 'blocked');
	assert.equal(first.report.items[0].nextStep.code, 'repair-assets-before-archive');
	assert.equal(first.report.archive.counts.blocked, 1);
	assert.ok((await stat(first.report.items[0].output)).isFile());
	await assert.rejects(stat(s.vault), { code: 'ENOENT' });
	const cached = await clip(s.options);
	assert.equal(cached.exitCode, 1);
	assert.equal(cached.report.items[0].status, 'skipped');
	assert.equal(cached.report.items[0].archive.code, 'incomplete-assets');
	assert.equal(cached.report.items[0].nextStep.code, 'repair-assets-before-archive');
	await assert.rejects(stat(path.join(s.vault, 'Papers')), { code: 'ENOENT' });
	const noOptIn = setup('remote-images', '/images');
	const remote = await clip(noOptIn.options);
	assert.equal(remote.exitCode, 1);
	assert.equal(remote.report.items[0].assets, undefined);
	assert.equal(remote.report.items[0].archive.code, 'incomplete-assets');
});

test('cached conversion is checked against current requirements, source identity and the accepted snapshot', { timeout: 25000 }, async () => {
	const s = setup('cached');
	const converted = await clip(parseOptions([baseUrl + '/article', '-o', s.output, '--fetch', 'http']));
	const file = converted.report.items[0].output;
	const before = requests;
	const stricter = await clip(parseOptions([baseUrl + '/article', '-o', s.output, '--vault', s.vault, '--require-section', 'Discussion']));
	assert.equal(stricter.exitCode, 1);
	assert.equal(stricter.report.items[0].archive.code, 'content-check');
	assert.ok(stricter.report.items[0].archive.quality.reasons.includes('missing-section:Discussion'));
	const wrongSource = await clip(parseOptions([baseUrl + '/other', '--output', file, '--vault', s.vault]));
	assert.equal(wrongSource.exitCode, 1);
	assert.equal(wrongSource.report.items[0].archive.code, 'source-mismatch');
	const accepted = await clip(s.options);
	assert.equal(accepted.report.items[0].status, 'skipped');
	assert.equal(accepted.report.items[0].archive.status, 'archived');
	await writeFile(file, (await readFile(file, 'utf8')) + '\nUnverified edit');
	const edited = await clip(s.options);
	assert.equal(edited.exitCode, 1);
	assert.match(edited.report.items[0].archive.error, /unverified edit/);
	assert.equal(requests, before);
});

test('Nature caption failures block fresh imports and both URL/import legacy-cache archive routes without touching notes', async () => {
	const url = 'https://www.nature.com/articles/fixture';
	const figure = '<figure><figcaption>Fig. 1: Overview.</figcaption><img src="/figure.png" width="685" height="395"><div class="c-article-section__figure-description" id="figure-1-desc"><p>Detailed panel description.</p></div></figure>';
	const source = full.replace('</article>', figure + '</article>');
	const s = setup('nature-cache');
	const input = await exportPair(path.join(directory, 'nature-cache/input'), 'nature.html', source, url);
	const initial = await clip(parseOptions([input, '-o', s.output]));
	assert.equal(initial.exitCode, 0);
	const item = initial.report.items[0];
	assert.equal(item.quality.figureCaptions.matched, 1);
	const paperReport = JSON.parse(await readFile(`${item.output}.report.json`, 'utf8'));
	const accepted = path.join(paperReport.artifactDirectory, 'accepted.md');
	const current = await readFile(item.output, 'utf8');
	assert.equal(current.split('Detailed panel description.').length, 2);
	const legacy = current.replace('Detailed panel description.', '');
	await writeFile(item.output, legacy);
	await writeFile(accepted, legacy);
	delete paperReport.checks.figureCaptions;
	delete paperReport.attempts[0].quality.figureCaptions;
	delete paperReport.attempts[0].quality.outputFigureCaptions;
	await writeFile(`${item.output}.report.json`, JSON.stringify(paperReport));
	const before = requests;
	for (const args of [[input, '-o', s.output], [url, '--output', item.output]]) {
		const result = await clip(parseOptions([...args, '--vault', s.vault]));
		assert.equal(result.exitCode, 1);
		assert.equal(result.report.items[0].status, 'skipped');
		assert.equal(result.report.items[0].archive.code, 'figure-captions');
		assert.equal(result.report.items[0].nextStep.code, 'repair-figure-captions');
		const lines = [];
		printResult(result, line => lines.push(line));
		assert.ok(lines.some(line => line.includes('Fig. 1: Overview.')));
		await assert.rejects(stat(path.join(s.vault, 'Papers')), { code: 'ENOENT' });
		assert.equal(await readFile(item.output, 'utf8'), legacy);
	}
	const bad = await exportPair(path.join(directory, 'nature-rejected/input'), 'nature.html', source.replace('<p>Detailed panel', '<p hidden>Detailed panel'), url);
	const rejected = await clip(parseOptions([bad, '-o', path.join(directory, 'nature-rejected/converted'), '--vault', s.vault]));
	assert.equal(rejected.exitCode, 2);
	assert.equal(rejected.report.items[0].status, 'incomplete');
	assert.equal(rejected.report.items[0].archive.status, 'blocked');
	assert.equal(rejected.report.items[0].nextStep.code, 'repair-figure-captions');
	await assert.rejects(stat(rejected.report.items[0].output), { code: 'ENOENT' });
	assert.equal(requests, before);
});

test('legacy accepted snapshots cannot bypass current section checks on either archive route', { timeout: 15000 }, async () => {
	const s = setup('legacy-sections');
	const input = await exportPair(path.join(directory, 'legacy-sections/input'), 'paper.html');
	const initial = await clip(parseOptions([input, '-o', s.output]));
	assert.equal(initial.exitCode, 0);
	const item = initial.report.items[0];
	const report = JSON.parse(await readFile(`${item.output}.report.json`, 'utf8'));
	const attempt = report.attempts.find(entry => entry.status === 'passed-checks');
	const legacy = `## Main\n\n## Methods\n\n## Funding\n\n${paragraph}`;
	// Recreate an old, internally consistent accepted cache without the new check.
	await writeFile(item.output, legacy);
	await writeFile(path.join(report.artifactDirectory, 'accepted.md'), legacy);
	await writeFile(attempt.markdown, legacy);
	delete report.checks.bodyCheck;
	attempt.quality = { passed: true, reasons: [] };
	await writeFile(`${item.output}.report.json`, JSON.stringify(report));
	const before = requests;
	for (const args of [[input, '-o', s.output], [baseUrl + '/article', '--output', item.output]]) {
		const result = await clip(parseOptions([...args, '--vault', s.vault]));
		assert.equal(result.exitCode, 1);
		assert.equal(result.report.items[0].status, 'skipped');
		assert.equal(result.report.items[0].archive.code, 'content-check');
		assert.equal(result.report.items[0].archive.quality.mainBodyWords, 0);
		assert.equal(await readFile(item.output, 'utf8'), legacy);
		assert.equal(result.report.items[0].archive.output, undefined);
		await assert.rejects(stat(path.join(s.vault, 'Papers')), { code: 'ENOENT' });
	}
	assert.equal(requests, before);
});

test('legacy Nature caches missing a prose paragraph fail both archive routes without rewriting notes', async () => {
	const url = 'https://www.nature.com/articles/fixture';
	const section = (title, body) => `<section data-title="${title}"><div><h2 class="c-article-section__title">${title}</h2><div class="c-article-section__content">${body}</div></div></section>`;
	const source = full.replace(/<article>[\s\S]*?<\/article>/, `<article class="c-article-body"><h1>Test paper</h1><div class="main-content">${section('Main', `<p>${paragraph}</p><p>Unique preserved source paragraph.</p>`)}${section('Methods', `<p>${paragraph}</p>`)}</div></article>`);
	const s = setup('nature-source-cache');
	const input = await exportPair(path.join(directory, 'nature-source-cache/input'), 'paper.html', source, url);
	const initial = await clip(parseOptions([input, '-o', s.output]));
	assert.equal(initial.exitCode, 0);
	const item = initial.report.items[0];
	assert.equal(item.quality.sourceSections.status, 'passed');
	const report = JSON.parse(await readFile(`${item.output}.report.json`, 'utf8'));
	const legacy = (await readFile(item.output, 'utf8')).replace('Unique preserved source paragraph.', '');
	await writeFile(item.output, legacy);
	await writeFile(path.join(report.artifactDirectory, 'accepted.md'), legacy);
	delete report.checks.sourceSections;
	delete report.attempts[0].quality.sourceSections;
	delete report.attempts[0].quality.outputSourceSections;
	await writeFile(`${item.output}.report.json`, JSON.stringify(report));
	await mkdir(s.vault, { recursive: true });
	const note = path.join(s.vault, 'manual.md');
	await writeFile(note, 'My annotations stay unchanged.');
	const mtime = (await stat(note)).mtimeMs;
	const before = requests;
	for (const args of [[input, '-o', s.output], [url, '--output', item.output]]) {
		const result = await clip(parseOptions([...args, '--vault', s.vault]));
		assert.equal(result.exitCode, 1);
		assert.equal(result.report.items[0].archive.code, 'source-sections');
		assert.equal(result.report.items[0].nextStep.code, 'repair-source-sections');
		assert.equal(await readFile(item.output, 'utf8'), legacy);
		assert.equal(await readFile(note, 'utf8'), 'My annotations stay unchanged.');
		assert.equal((await stat(note)).mtimeMs, mtime);
		await assert.rejects(stat(path.join(s.vault, 'Papers')), { code: 'ENOENT' });
	}
	assert.equal(requests, before);
});

test('Vault runtime path checks precede conversion; lock failures retain converted Markdown and can be retried', { timeout: 20000 }, async () => {
	const bad = setup('bad-path');
	await mkdir(path.dirname(bad.vault), { recursive: true });
	await writeFile(bad.vault, 'Existing file');
	const before = requests;
	await assert.rejects(clip(bad.options), /plain directory/);
	assert.equal(requests, before);
	assert.equal(await readFile(bad.vault, 'utf8'), 'Existing file');
	await assert.rejects(stat(bad.output), { code: 'ENOENT' });
	const linked = setup('linked-output');
	await mkdir(linked.vault, { recursive: true });
	await symlink(linked.vault, linked.output, process.platform === 'win32' ? 'junction' : 'dir');
	await assert.rejects(clip(linked.options), /plain directory/);
	assert.equal(requests, before);
	const locked = setup('locked');
	await mkdir(path.join(locked.vault, '.paper-clipper'), { recursive: true });
	const lockFile = path.join(locked.vault, '.paper-clipper/archive.lock');
	await writeFile(lockFile, 'Owned by another process');
	const result = await clip(locked.options);
	assert.equal(result.exitCode, 1);
	assert.equal(result.report.items[0].status, 'success');
	assert.equal(result.report.items[0].archive.status, 'failed');
	assert.match(result.report.archive.error, /lock exists/);
	assert.equal(await readFile(lockFile, 'utf8'), 'Owned by another process');
	const retry = await clip(parseOptions([baseUrl + '/article', '-o', locked.output, '--vault', path.join(directory, 'new-vault')]));
	assert.equal(retry.report.items[0].archive.status, 'archived');
	assert.equal(retry.report.items[0].status, 'skipped');
});

test('public CLI advertises vault options and exits nonzero on archive failures', { timeout: 15000 }, async () => {
	const entry = path.join(root, 'scripts/clip.mjs');
	const help = await exec(process.execPath, [entry, '--help'], { windowsHide: true });
	assert.match(help.stdout, /--vault/);
	assert.match(help.stdout, /clip:vault --dry-run/);
	const s = setup('cli-images');
	await assert.rejects(exec(process.execPath, [entry, baseUrl + '/images', '-o', s.output, '--vault', s.vault, '--fetch', 'http'], { windowsHide: true }),
		error => error.code === 1 && /Vault summary:.*failed=1/.test(error.stdout) && /images are unresolved/.test(error.stdout));
});
