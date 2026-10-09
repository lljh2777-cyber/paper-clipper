import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, symlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createWatcher, parseOptions, main } from './watch-exports.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const paragraph = 'This research compares tissue expression and spatial organization across biological samples. '.repeat(100);
const html = `<html><head><title>Inbox research</title></head><body><article><h1>Inbox research</h1><h2>Results</h2><p>${paragraph}</p><h2>Methods</h2><p>${paragraph}</p></article></body></html>`;
async function setup() {
	const base = path.join(root, 'output/browser-fetch/tests');
	await mkdir(base, { recursive: true });
	const dir = await mkdtemp(path.join(base, 'watch-'));
	const inbox = path.join(dir, 'inbox'), output = path.join(dir, 'output');
	await mkdir(inbox);
	const args = [inbox, '-o', output, '--settle', '100'];
	return { dir, inbox, output, args, options: parseOptions(args) };
}
async function pair(inbox, name = 'paper.html', content = html) {
	const file = path.join(inbox, name);
	await writeFile(file, content);
	await writeFile(`${file}.json`, JSON.stringify({ schemaVersion: 1, captureMethod: 'clipper-dom',
		url: 'https://example.org/article', sourceUrl: 'https://example.org/article', baseURI: 'https://example.org/article',
		title: 'Inbox research', capturedAt: '2026-10-09T00:00:00Z', charset: 'UTF-8', htmlFile: name, htmlBytes: Buffer.byteLength(content) }));
	return file;
}
const quiet = { log: () => {} };

test('watch options reject unsafe or unsupported routes and preserve existing thresholds', () => {
	for (const args of [[], ['https://example.org'], ['in', '--overwrite'], ['in', '--interval', '0'], ['in', '-o', 'in/out'], ['in', '--vault', 'in/vault'], ['in', '--min-words', '0']]) assert.throws(() => parseOptions(args));
	assert.deepEqual(parseOptions(['--help']), { help: true });
	const options = parseOptions(['in', '-o', 'out', '--download-assets', '--require-section', 'Results']);
	assert.ok(options.forward.includes('--download-assets'));
	assert.ok(options.forward.includes('1000'));
});

test('waits for pairs and stability, ignores partial downloads and nested directories', async () => {
	const s = await setup(); let time = 0, calls = 0;
	const watcher = await createWatcher(s.options, { ...quiet, now: () => time, runClip: async () => { calls++; throw new Error('Synthetic failure'); } });
	try {
		await mkdir(path.join(s.inbox, 'nested'));
		await pair(path.join(s.inbox, 'nested'));
		await writeFile(path.join(s.inbox, 'pending.crdownload'), html);
		assert.equal((await watcher.scan()).pending, 0);
		await writeFile(path.join(s.inbox, 'paper.html'), html);
		assert.equal((await watcher.scan()).pending, 1);
		time = 200; assert.equal((await watcher.scan()).pending, 1);
		await pair(s.inbox); await watcher.scan();
		time = 250; await watcher.scan(); assert.equal(calls, 0);
		time = 400; assert.equal((await watcher.scan()).processed[0].status, 'failed');
		await watcher.scan(); assert.equal(calls, 1);
	} finally { await watcher.close(); }
	const restarted = await createWatcher(s.options, { ...quiet, runClip: async () => { calls++; } });
	try { assert.equal((await restarted.scan()).processed.length, 0); assert.equal(calls, 1); }
	finally { await restarted.close(); }
});

test('real pipeline accepts synthetic full HTML, rejects preview, retains inputs and existing output', async () => {
	const s = await setup(); let time = 0;
	const source = await pair(s.inbox);
	await pair(s.inbox, 'preview.html', '<html><body><article>This is a preview of subscription content</article></body></html>');
	const watcher = await createWatcher(s.options, { ...quiet, now: () => time });
	try {
		await watcher.scan(); time = 200;
		const result = await watcher.scan();
		assert.deepEqual(result.processed.map(item => item.status), ['success', 'incomplete']);
		assert.equal(await readFile(source, 'utf8'), html);
		const output = path.join(s.output, 'paper.md');
		const saved = await readFile(output, 'utf8');
		assert.match(saved, /Results/);
		await pair(s.inbox, 'paper.html', html.replace('Inbox research', 'Updated inbox research'));
		await watcher.scan(); time = 400;
		assert.equal((await watcher.scan()).processed[0].status, 'skipped');
		assert.equal(await readFile(output, 'utf8'), saved);
	} finally { await watcher.close(); }
});

test('single writer, corrupt state and linked directories fail closed', async () => {
	const s = await setup();
	const first = await createWatcher(s.options, quiet);
	await assert.rejects(createWatcher(s.options, quiet), /lock exists/);
	await first.close(); await first.close();
	await writeFile(first.statePath, '{broken');
	await assert.rejects(createWatcher(s.options, quiet), /JSON|position|property/i);
	assert.equal(await readFile(first.statePath, 'utf8'), '{broken');
	await assert.rejects(lstat(path.join(s.output, '_inbox/watcher.lock')), { code: 'ENOENT' });
	const linked = path.join(s.dir, 'linked');
	await symlink(s.inbox, linked, process.platform === 'win32' ? 'junction' : 'dir');
	await assert.rejects(createWatcher(parseOptions([linked, '-o', path.join(s.dir, 'other')]), quiet), /plain directory/);
});

test('failure does not stop later pairs, concurrent scans are rejected, cancellation stops the batch', async () => {
	const s = await setup(); let time = 0, release, entered;
	await pair(s.inbox, 'a.html'); await pair(s.inbox, 'b.html');
	const started = new Promise(resolve => { entered = resolve; });
	const gate = new Promise(resolve => { release = resolve; });
	const stop = new AbortController();
	const watcher = await createWatcher(s.options, { ...quiet, now: () => time, runClip: async () => { entered(); await gate; throw new Error('Synthetic failure'); } });
	try {
		await watcher.scan(); time = 200;
		const running = watcher.scan({ signal: stop.signal }); await started;
		await assert.rejects(watcher.scan(), /already running/);
		stop.abort(); release(); assert.equal((await running).processed.length, 1);
		assert.equal((await watcher.scan()).processed.length, 1);
	} finally { release(); await watcher.close(); }
});

test('once exits with pending status and releases lock without converting half a pair', async () => {
	const s = await setup();
	await writeFile(path.join(s.inbox, 'half.html'), html);
	assert.equal(await main([...s.args, '--once']), 3);
	await assert.rejects(lstat(path.join(s.output, '_inbox/watcher.lock')), { code: 'ENOENT' });
});

test('JSON-first delivery and subsequent writes restart the stability window', async () => {
	const s = await setup(); let time = 0, calls = 0;
	const watcher = await createWatcher(s.options, { ...quiet, now: () => time, runClip: async () => { calls++; throw new Error('Synthetic terminal result'); } });
	try {
		await writeFile(path.join(s.inbox, 'paper.html.json'), '{}');
		await watcher.scan(); time = 200; assert.equal((await watcher.scan()).pending, 1);
		await pair(s.inbox); await watcher.scan(); time = 250;
		await writeFile(path.join(s.inbox, 'paper.html'), `${html}changed`);
		await watcher.scan(); time = 320; await watcher.scan(); assert.equal(calls, 0);
		time = 400; await watcher.scan(); assert.equal(calls, 1);
	} finally { await watcher.close(); }
	assert.equal(await main([...s.args, '--once']), 1);
});

test('malformed metadata fails without preventing the next valid real conversion', async () => {
	const s = await setup(); let time = 0;
	const bad = await pair(s.inbox, 'a.html'); await writeFile(`${bad}.json`, '{}');
	await pair(s.inbox, 'b.html');
	const watcher = await createWatcher(s.options, { ...quiet, now: () => time });
	try {
		await watcher.scan(); time = 200;
		assert.deepEqual((await watcher.scan()).processed.map(item => item.status), ['failed', 'success']);
		assert.equal((await watcher.scan()).retained.length, 2);
	} finally { await watcher.close(); }
});

test('state belonging to another inbox is preserved and rejected', async () => {
	const s = await setup(); const watcher = await createWatcher(s.options, quiet);
	await watcher.close();
	const state = JSON.stringify({ schemaVersion: 1, inbox: path.join(s.dir, 'other'), entries: {} });
	await writeFile(watcher.statePath, state);
	await assert.rejects(createWatcher(s.options, quiet), /another inbox/);
	assert.equal(await readFile(watcher.statePath, 'utf8'), state);
});
