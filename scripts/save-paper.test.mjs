import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseOptions, savePaper } from './save-paper.mjs';
import { assessPaperIdentity, paperMetadata } from './paper-metadata.mjs';
import { archivePapers, parseOptions as archiveOptions } from './archive-papers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const title = 'A full experimental paper for testing reliable Agent acquisition';
const doi = '10.1234/agent-paper';
const otherDoi = '10.1234/other-paper';
const paragraph = 'This study compares expression measurements across tissue samples with validated experimental observations. '.repeat(90);
const full = `<html><head><title>${title}</title><meta name="citation_title" content="${title}"><meta name="citation_doi" content="${doi}"></head><body><article><h1>${title}</h1><h2>Results</h2><p>${paragraph}</p><h2>Methods</h2><p>${paragraph}</p></article></body></html>`;
const preview = '<html><head><title>Preview</title></head><body><article><h1>Preview</h1><p>This is a preview of subscription content.</p></article></body></html>';
let directory, server, baseUrl;
let requests = 0;
let currentHtml = full;

before(async () => {
	await mkdir(path.join(root, 'output/browser-fetch/tests'), { recursive: true });
	directory = await mkdtemp(path.join(root, 'output/browser-fetch/tests/paper-agent-'));
	server = createServer((request, response) => {
		requests++;
		response.setHeader('Content-Type', 'text/html');
		if (request.url === '/denied') response.writeHead(403);
		if (request.url === '/missing') response.writeHead(404);
		response.end(request.url === '/preview' ? preview : currentHtml);
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
});

function setup(name, extra = [], route = '/article') {
	const output = path.join(directory, name, 'converted');
	const vault = path.join(directory, name, 'Vault');
	const options = parseOptions([title, '-o', output, '--fetch', 'http', ...extra]);
	const resolve = async () => ({ kind: 'title', status: 'resolved', selected: { title, doi, url: baseUrl + route }, candidates: [] });
	return { output, vault, options, resolve };
}

async function exportPair(folder, name, html = full, url = baseUrl + '/article') {
	await mkdir(folder, { recursive: true });
	const input = path.join(folder, name);
	await writeFile(input, html);
	await writeFile(`${input}.json`, JSON.stringify({ schemaVersion: 1, captureMethod: 'clipper-dom', title,
		url, capturedAt: '2026-10-07T12:44:00.000Z', charset: 'UTF-8', htmlFile: name, htmlBytes: Buffer.byteLength(html) }));
	return input;
}

test('Agent options reuse capture boundaries without enabling downloads or overwrite', () => {
	const options = parseOptions([title, '--require-section', 'Results', '--require-section', 'Methods']);
	assert.equal(options.query, title);
	assert.ok(!options.forwardArgs.includes('--download-assets'));
	assert.ok(!options.forwardArgs.includes('--overwrite'));
	for (const args of [[], [title, 'second'], [title, '--resolve-timeout', '0'], [title, '--mailto', 'no'],
		[title, '--html', 'paper.html', '--fetch', 'http'], [title, '--html', 'paper.html', '--resolve-only'],
		[title, '--html', 'exports'], [title, '--vault', 'Vault', '-o', 'Vault/Papers'], [title, '--template', 'custom.json']]) {
		assert.throws(() => parseOptions(args));
	}
});

test('ambiguous and missing titles never start capture; failures stay distinct and reports persist', async () => {
	for (const status of ['needs-selection', 'not-found', 'error']) {
		const s = setup(`resolve-${status}`);
		const result = await savePaper(s.options, { resolve: async () => {
			if (status === 'error') throw Object.assign(new Error('Service unavailable'), { code: 'resolver-rate-limited', retryAfter: '30' });
			return { status, candidates: [], selected: null };
		}, runClip: () => assert.fail('Must not capture') });
		assert.equal(result.status, status === 'error' ? 'failed' : status);
		assert.equal(result.exitCode, status === 'needs-selection' ? 3 : 1);
		assert.equal(result.saved, false);
		assert.equal(result.output, null);
		assert.deepEqual(JSON.parse(await readFile(result.reportPath, 'utf8')), result);
		assert.deepEqual(await readdir(s.output), ['_papers']);
		if (status === 'error') assert.equal(result.retryAfter, '30');
	}
});

test('resolve-only returns a decision without creating any directories or calling capture', async () => {
	const s = setup('resolve-only', ['--resolve-only']);
	const result = await savePaper(s.options, { resolve: s.resolve, runClip: () => assert.fail() });
	assert.equal(result.status, 'resolved');
	assert.equal(result.saved, false);
	assert.equal(result.reportPath, undefined);
	await assert.rejects(stat(s.output), { code: 'ENOENT' });
});

test('DOI identity requires publisher metadata, not a body citation or URL inference', () => {
	assert.equal(assessPaperIdentity(full, doi).status, 'passed');
	assert.equal(assessPaperIdentity(full.replace(doi, otherDoi), doi).reason, 'different-publisher-doi');
	const missing = full.replace(/<meta name="citation_doi"[^>]+>/, '');
	assert.equal(assessPaperIdentity(missing.replace('</article>', `<p>Reference: ${doi}</p></article>`), doi).reason, 'missing-publisher-doi');
	assert.equal(assessPaperIdentity(full.replace('</head>', `<meta name="prism.doi" content="${otherDoi}"></head>`), doi).reason, 'conflicting-publisher-dois');
	assert.equal(assessPaperIdentity(full.replace(doi, 'invalid'), doi).reason, 'invalid-publisher-doi');
	for (const name of ['prism.doi', 'DC.Identifier']) {
		const html = full.replace('citation_doi', name).replace(doi, `https://doi.org/${doi.toUpperCase()}`);
		assert.equal(assessPaperIdentity(html, doi).status, 'passed');
		assert.equal(paperMetadata(html, { url: baseUrl }).doi, doi);
	}
});

test('title-selected identity flows through real capture, archive and duplicate preservation', { timeout: 20000 }, async () => {
	const s = setup('archive');
	s.options = parseOptions([title, '-o', s.output, '--vault', s.vault, '--fetch', 'http']);
	const first = await savePaper(s.options, { resolve: s.resolve });
	assert.equal(first.status, 'saved');
	assert.equal(first.saved, true);
	assert.equal(first.conversion.quality.paperIdentity.status, 'passed');
	assert.equal(first.conversion.archive.paperIdentity.expected, doi);
	assert.equal(first.output, first.conversion.archive.output);
	const annotated = await readFile(first.output, 'utf8') + '\n## My notes\n\nKeep these annotations.\n';
	await writeFile(first.output, annotated);
	const timestamp = (await stat(first.output)).mtimeMs;
	const before = requests;
	const repeat = await savePaper(s.options, { resolve: s.resolve });
	assert.equal(repeat.status, 'duplicate');
	assert.equal(repeat.saved, false);
	assert.equal(repeat.output, first.output);
	assert.equal(requests, before);
	assert.equal(await readFile(first.output, 'utf8'), annotated);
	assert.equal((await stat(first.output)).mtimeMs, timestamp);
});

test('conversion-only repeat is existing-unverified, never a new successful save', { timeout: 15000 }, async () => {
	const s = setup('conversion-only');
	const first = await savePaper(s.options, { resolve: s.resolve });
	assert.equal(first.status, 'saved');
	const second = await savePaper(s.options, { resolve: s.resolve });
	assert.equal(second.status, 'existing-unverified');
	assert.equal(second.exitCode, 3);
	assert.equal(second.output, null);
	assert.equal(second.existingOutput, first.output);
});

test('wrong DOI prevents publishing, including intentional overwrite of an old good conversion', { timeout: 20000 }, async () => {
	const s = setup('wrong-identity');
	const first = await savePaper(s.options, { resolve: s.resolve });
	const bytes = await readFile(first.output);
	try {
		currentHtml = full.replace(doi, otherDoi);
		const options = parseOptions([title, '-o', s.output, '--vault', s.vault, '--fetch', 'http', '--overwrite', '--download-assets']);
		const result = await savePaper(options, { resolve: s.resolve });
		assert.equal(result.status, 'incomplete');
		assert.equal(result.saved, false);
		assert.equal(result.conversion.outputWritten, false);
		assert.equal(result.conversion.assets, undefined);
		assert.equal(result.conversion.nextStep.code, 'verify-paper-identity');
		assert.ok(result.conversion.quality.reasons.includes('paper-identity'));
		assert.deepEqual(await readFile(first.output), bytes);
		await assert.rejects(stat(s.vault), { code: 'ENOENT' });
	} finally { currentHtml = full; }
});

test('cached conversion cannot bypass a newly requested DOI during archiving', { timeout: 15000 }, async () => {
	const s = setup('cache-identity');
	const first = await savePaper(s.options, { resolve: s.resolve });
	const options = parseOptions([otherDoi, '-o', s.output, '--vault', s.vault, '--fetch', 'http']);
	const result = await savePaper(options, { resolve: async () => ({ status: 'resolved', selected: { doi: otherDoi, url: baseUrl + '/article' } }) });
	assert.equal(result.status, 'incomplete');
	assert.equal(result.conversion.status, 'skipped');
	assert.equal(result.conversion.archive.code, 'paper-identity');
	assert.equal(result.output, null);
	assert.deepEqual(await readdir(s.vault), ['.paper-clipper']);
	await assert.rejects(stat(path.join(s.vault, 'Papers')), { code: 'ENOENT' });
	// Standalone archiving also uses the recorded expected DOI.
	const reportPath = `${first.output}.report.json`;
	const stored = JSON.parse(await readFile(reportPath, 'utf8'));
	stored.checks.expectedDoi = otherDoi;
	await writeFile(reportPath, JSON.stringify(stored));
	const standalone = await archivePapers(archiveOptions([first.output, '--vault', s.vault, '--dry-run']));
	assert.equal(standalone.report.items[0].code, 'paper-identity');
});

test('authorized export can follow DOI selection offline, preserving source and metadata', { timeout: 20000 }, async () => {
	const s = setup('html');
	const input = await exportPair(path.join(directory, 'html/input'), 'article.html');
	const before = requests;
	const options = parseOptions([doi, '--html', input, '-o', s.output, '--vault', s.vault]);
	const result = await savePaper(options);
	assert.equal(result.status, 'saved');
	assert.equal(result.conversion.quality.paperIdentity.status, 'passed');
	assert.equal(result.conversion.archive.metadata.captured_at, '2026-10-07T12:44:00.000Z');
	assert.equal(requests, before);
	assert.equal(await readFile(input, 'utf8'), full);
	const wrong = await savePaper(parseOptions([otherDoi, '--html', input, '-o', s.output + '-wrong']));
	assert.equal(wrong.status, 'incomplete');
});

test('URL plus export requires matching source; missing pairs do not become successful saves', async () => {
	const input = await exportPair(path.join(directory, 'source/input'), 'article.html');
	const s = setup('source');
	const wrong = await savePaper(parseOptions(['https://example.org/other', '--html', input, '-o', s.output]), { runClip: () => assert.fail() });
	assert.equal(wrong.status, 'failed');
	assert.match(wrong.error, /does not match/);
	const bare = path.join(directory, 'source/input/bare.html');
	await writeFile(bare, full);
	const missing = await savePaper(parseOptions([doi, '--html', bare, '-o', s.output]));
	assert.equal(missing.status, 'failed');
	assert.equal(missing.saved, false);
});

test('subscription preview and HTTP 403 need access, while HTTP 404 remains failure', { timeout: 15000 }, async () => {
	for (const [route, status] of [['/preview', 'needs-access'], ['/denied', 'needs-access'], ['/missing', 'failed']]) {
		const s = setup(`access-${status}-${route.slice(1)}`, [], route);
		const result = await savePaper(s.options, { resolve: s.resolve });
		assert.equal(result.status, status);
		assert.equal(result.saved, false);
		assert.equal(result.output, null);
		if (status === 'needs-access') assert.equal(result.conversion.nextStep.code, 'export-authorized-tab');
	}
});

test('CLI prints one parseable JSON result on stdout and uses matching exit codes', async () => {
	const { stdout } = await exec(process.execPath, ['scripts/save-paper.mjs', doi, '--resolve-only'], { cwd: root });
	assert.equal(JSON.parse(stdout).status, 'resolved');
	await assert.rejects(exec(process.execPath, ['scripts/save-paper.mjs'], { cwd: root }), error => {
		assert.equal(error.code, 1);
		assert.equal(JSON.parse(error.stdout).status, 'failed');
		return true;
	});
	const s = setup('cli-json');
	const run = await exec(process.execPath, ['scripts/save-paper.mjs', baseUrl + '/article', '--fetch', 'http', '-o', s.output], { cwd: root });
	assert.equal(JSON.parse(run.stdout).status, 'saved');
	assert.match(run.stderr, /Fetching via http/);
});
