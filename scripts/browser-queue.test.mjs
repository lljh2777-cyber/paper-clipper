import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { startQueue, parseOptions, readPairingKey, startupMessage } from './browser-queue.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const paragraph = 'This research compares tissue expression and spatial organization across biological samples. '.repeat(100);
const full = `<html><head><title>Queue fixture</title><meta name="citation_doi" content="10.1234/queue"></head><body><article><h1>Queue fixture</h1><h2>Results</h2><p>${paragraph}</p><h2>Methods</h2><p>${paragraph}</p></article></body></html>`;
const snapshot = (html = full, url = 'https://example.org/paper') => ({ html, url, baseURI: url, title: 'Queue fixture', capturedAt: '2026-10-09T00:00:00Z', htmlBytes: Buffer.byteLength(html) });
async function setup(queries = ['10.1234/queue'], extra = [], dependencies = {}) {
	const parent = path.join(root, 'output/browser-queue-tests'); await mkdir(parent, { recursive: true });
	const output = await mkdtemp(path.join(parent, 'run-'));
	const options = parseOptions([...queries, '-o', output, ...extra]); options.port = 0;
	const server = await startQueue(options, { log: () => {}, ...dependencies });
	const request = async (route, data, headers = {}) => {
		const response = await fetch(server.url + route, { method: data === undefined ? 'GET' : 'POST',
			headers: { Authorization: `Bearer ${server.key}`, 'Content-Type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
		return { status: response.status, data: await response.json() };
	};
	return { ...server, options, output, request };
}

test('queue rejects unsafe arguments and preserves default quality thresholds', () => {
	for (const args of [[], ['10.1234/test', '--port', '0'], ['10.1234/test', '--overwrite'], ['10.1234/test', '--fetch', 'browser'], ['file:///private']]) assert.throws(() => parseOptions(args));
	assert.deepEqual(parseOptions(['--help']), { help: true });
	assert.ok(parseOptions(['10.1234/test']).forward.includes('1000'));
});

test('loopback service requires pairing, rejects web origins and offers no remote enqueue', async () => {
	const s = await setup();
	try {
		assert.equal((await s.request('/v1/jobs', undefined, { Authorization: '' })).status, 401);
		assert.equal((await s.request('/v1/jobs', undefined, { Origin: 'https://example.org' })).status, 403);
		const hostStatus = await new Promise((resolve, reject) => {
			const request = httpRequest(`${s.url}/v1/jobs`, { headers: { Host: 'rebind.example.org', Authorization: `Bearer ${s.key}` } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
			request.on('error', reject); request.end();
		});
		assert.equal(hostStatus, 403);
		assert.equal((await s.request('/v1/jobs', undefined, { Origin: `chrome-extension://${'a'.repeat(32)}` })).status, 200);
		assert.equal((await s.request('/v1/enqueue', { url: 'https://example.org' })).status, 404);
		assert.equal((await s.request('/v1/jobs')).data.jobs[0].lease, undefined);
	} finally { await s.close(); }
});

test('claims are serialized, pauses block subsequent tasks and resume invalidates the old lease', async () => {
	const s = await setup(['10.1234/queue', '10.1234/other']);
	try {
		const first = (await s.request('/v1/claim', {})).data.job;
		assert.equal((await s.request('/v1/claim', {})).data.job, null);
		await s.request(`/v1/jobs/${first.id}/pause`, { lease: first.lease, reason: 'Human login' });
		assert.equal((await s.request('/v1/claim', {})).data.job, null);
		await s.request(`/v1/jobs/${first.id}/resume`, {});
		const next = (await s.request('/v1/claim', {})).data.job;
		assert.notEqual(next.lease, first.lease);
		assert.equal((await s.request(`/v1/jobs/${first.id}/capture`, { ...snapshot(), lease: first.lease })).status, 400);
		await s.request(`/v1/jobs/${first.id}/skip`, {});
		assert.notEqual((await s.request('/v1/claim', {})).data.job.id, first.id);
	} finally { await s.close(); }
});

test('real conversion preserves DOI checks, quality states and rejects replay', async () => {
	const s = await setup();
	try {
		const job = (await s.request('/v1/claim', {})).data.job;
		const result = await s.request(`/v1/jobs/${job.id}/capture`, { ...snapshot(), lease: job.lease });
		assert.equal(result.status, 200); assert.equal(result.data.job.status, 'saved');
		assert.equal(result.data.job.result.conversion.quality.coverage.status, 'heuristic-only');
		assert.match(await readFile(result.data.job.result.output, 'utf8'), /Results/);
		assert.equal((await s.request(`/v1/jobs/${job.id}/capture`, { ...snapshot(), lease: job.lease })).status, 400);
		assert.doesNotMatch(await readFile(s.reportPath, 'utf8'), new RegExp(s.key));
	} finally { await s.close(); }
});

test('preview and wrong DOI never save, and an unchanged blocked task is not retried', async () => {
	for (const html of [full.replace('10.1234/queue', '10.1234/wrong'), full.replace('<h1>', '<p>This is a preview of subscription content</p><h1>')]) {
		const s = await setup();
		try {
			const job = (await s.request('/v1/claim', {})).data.job;
			const response = (await s.request(`/v1/jobs/${job.id}/capture`, { ...snapshot(html), lease: job.lease })).data;
			assert.ok(['paused', 'needs-access'].includes(response.job.status));
			assert.equal(response.job.result.saved, false);
			assert.equal((await s.request('/v1/claim', {})).data.job, null);
		} finally { await s.close(); }
	}
});

test('URL-only identity and malformed capture metadata fail closed', async () => {
	const s = await setup(['https://example.org/expected']);
	try {
		const job = (await s.request('/v1/claim', {})).data.job;
		assert.equal((await s.request(`/v1/jobs/${job.id}/capture`, { ...snapshot(), htmlBytes: 1, lease: job.lease })).status, 400);
		const result = await s.request(`/v1/jobs/${job.id}/capture`, { ...snapshot(), lease: job.lease });
		assert.equal(result.data.job.status, 'failed'); assert.equal(result.data.job.result.saved, false);
	} finally { await s.close(); }
});

test('pairing survives process/service restarts while task reports remain separate', async () => {
	const first = await setup(); const key = first.key; await first.close();
	const next = await startQueue(first.options, { log: () => {} });
	try { assert.equal(next.key, key); assert.notEqual(next.reportPath, first.reportPath); }
	finally { await next.close(); }
});

test('key viewing is explicit and read-only; startup and reports hide credentials', async () => {
	const s = await setup();
	try {
		assert.deepEqual(parseOptions(['--show-pairing-key', '-o', s.output]), { showKeyOnly: true, outputDir: s.output });
		assert.throws(() => parseOptions(['--show-pairing-key', '--port', '43127']));
		assert.equal(await readPairingKey(s.output), s.key);
		await assert.rejects(readPairingKey(path.join(s.output, 'absent')), { code: 'ENOENT' });
		assert.ok(!startupMessage(s).includes(s.key));
		assert.ok(startupMessage(s, true).includes(s.key));
		assert.ok(!(await readFile(s.reportPath, 'utf8')).includes(s.key));
	} finally { await s.close(); }
});

test('reset revokes credentials and leases, pauses claims and persists across restart', async () => {
	const logs = [], s = await setup(['10.1234/queue', '10.1234/other'], [], { log: message => logs.push(message) });
	let nextKey;
	try {
		const job = (await s.request('/v1/claim', {})).data.job;
		assert.equal((await s.request('/v1/pairing/reset', {}, { Authorization: '' })).status, 401);
		assert.equal((await s.request('/v1/pairing/reset', {}, { Origin: 'https://example.org' })).status, 403);
		const reset = await s.request('/v1/pairing/reset', {});
		assert.equal(reset.status, 200); nextKey = reset.data.key;
		assert.notEqual(nextKey, s.key); assert.equal(await readPairingKey(s.output), nextKey);
		assert.equal((await s.request('/v1/jobs', undefined, { Authorization: `Bearer ${s.key}` })).status, 401);
		assert.equal((await s.request('/v1/jobs')).data.jobs[0].status, 'paused');
		assert.equal((await s.request('/v1/claim', {})).data.job, null);
		await s.request(`/v1/jobs/${job.id}/resume`, {});
		const claimed = (await s.request('/v1/claim', {})).data.job;
		assert.notEqual(claimed.lease, job.lease);
		assert.equal((await s.request(`/v1/jobs/${job.id}/capture`, { ...snapshot(), lease: job.lease })).status, 400);
		for (const key of [s.key, nextKey]) {
			assert.ok(!logs.join('').includes(key)); assert.ok(!(await readFile(s.reportPath, 'utf8')).includes(key));
		}
	} finally { await s.close(); }
	const restarted = await startQueue(s.options, { log: () => {} });
	try { assert.equal(restarted.key, nextKey); } finally { await restarted.close(); }
});

test('reset cannot interrupt an active conversion', async () => {
	let release, started;
	const gate = new Promise(resolve => { release = resolve; });
	const entered = new Promise(resolve => { started = resolve; });
	const s = await setup(undefined, [], { runPaper: async () => { started(); await gate; return { status: 'saved' }; } });
	let capture;
	try {
		const job = (await s.request('/v1/claim', {})).data.job;
		capture = s.request(`/v1/jobs/${job.id}/capture`, { ...snapshot(), lease: job.lease });
		await entered;
		assert.equal((await s.request('/v1/pairing/reset', {})).status, 409);
		assert.equal(await readPairingKey(s.output), s.key);
		release(); assert.equal((await capture).data.job.status, 'saved');
	} finally { release(); await capture; await s.close(); }
});

test('requests with unfinished bodies cannot cross a key rotation', async () => {
	const s = await setup(); let pending;
	try {
		const response = new Promise((resolve, reject) => {
			pending = httpRequest(`${s.url}/v1/claim`, { method: 'POST', headers: { Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json' } }, result => {
				result.resume(); result.on('end', () => resolve(result.statusCode));
			});
			pending.on('error', reject); pending.write('{');
		});
		assert.equal((await s.request('/v1/pairing/reset', {})).status, 200);
		pending.end('}'); assert.equal(await response, 401);
		assert.equal((await s.request('/v1/jobs')).data.jobs[0].status, 'queued');
	} finally { pending?.destroy(); await s.close(); }
});

test('lossy custom templates are checked by the same conversion gate', async () => {
	const parent = path.join(root, 'output/browser-queue-tests'); await mkdir(parent, { recursive: true });
	const directory = await mkdtemp(path.join(parent, 'template-'));
	const template = path.join(directory, 'lossy.json');
	await writeFile(template, JSON.stringify({ noteNameFormat: '{{title}}', noteContentFormat: '{{title}}', properties: [] }));
	const s = await setup(['10.1234/queue'], ['--template', template]);
	try {
		const job = (await s.request('/v1/claim', {})).data.job;
		const result = (await s.request(`/v1/jobs/${job.id}/capture`, { ...snapshot(), lease: job.lease })).data.job;
		assert.equal(result.status, 'paused'); assert.equal(result.result.saved, false);
		assert.ok(result.result.conversion.quality.reasons.includes('output-too-short'));
	} finally { await s.close(); }
});

test('queue Vault writes retain existing DOI notes and personal annotations', async () => {
	const parent = path.join(root, 'output/browser-queue-tests'); await mkdir(parent, { recursive: true });
	const vault = await mkdtemp(path.join(parent, 'vault-'));
	const note = path.join(vault, 'personal.md'), original = '---\ndoi: 10.1234/queue\ncustom: keep\n---\nPersonal annotation.\n';
	await writeFile(note, original);
	const s = await setup(['10.1234/queue'], ['--vault', vault]);
	try {
		const job = (await s.request('/v1/claim', {})).data.job;
		const result = (await s.request(`/v1/jobs/${job.id}/capture`, { ...snapshot(), lease: job.lease })).data.job;
		assert.equal(result.status, 'duplicate'); assert.equal(await readFile(note, 'utf8'), original);
	} finally { await s.close(); }
});
