import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { classifyQuery, normalizeTitle, resolvePaper } from './resolve-paper.mjs';

const title = 'Novae: a graph-based foundation model for spatial transcriptomics data';
const doi = '10.1038/s41592-025-02899-6';
const work = (name = title, id = doi) => ({ type: 'journal-article', DOI: id, title: [name],
	author: [{ given: 'A', family: 'Researcher' }], 'container-title': ['Test Journal'], published: { 'date-parts': [[2025, 1]] } });
const response = items => new Response(JSON.stringify({ status: 'ok', message: { items, 'total-results': 400 } }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
const fetchItems = items => async () => response(items);

test('explicit DOI and URL resolution needs no network and does not claim verified metadata', async () => {
	for (const input of [doi, `doi: ${doi.toUpperCase()}`, `https://doi.org/${doi}`, `https://dx.doi.org/${doi}`]) {
		const result = await resolvePaper(input, { fetchImpl: () => assert.fail('No search expected') });
		assert.equal(result.kind, 'doi');
		assert.equal(result.selected.doi, doi);
		assert.equal(result.selected.url, `https://doi.org/${doi}`);
		assert.equal(result.metadataVerified, false);
	}
	const result = await resolvePaper('https://example.org/paper?utm_source=test#results', { fetchImpl: () => assert.fail() });
	assert.equal(result.selected.url, 'https://example.org/paper');
	assert.equal(result.selected.doi, null);
});

test('colon titles remain titles; malformed input and credentialed or non-HTTP URLs are rejected', () => {
	assert.equal(classifyQuery(title).kind, 'title');
	for (const input of ['', ' ', 'x\ny', 'x'.repeat(1001), 'doi: not-a-doi', 'ftp://example.org/a', 'file:///a', 'javascript:alert(1)', 'https://user:password@example.org']) {
		assert.throws(() => classifyQuery(input));
	}
});

test('unique exact title wins even when not first; returned identity is DOI not external metadata URL', async () => {
	const exact = { ...work(), URL: 'https://untrusted.example/not-the-paper' };
	const result = await resolvePaper(title, { fetchImpl: fetchItems([work('A similar study of spatial transcriptomics', '10.1234/other'), exact]) });
	assert.equal(result.status, 'resolved');
	assert.equal(result.selected.doi, doi);
	assert.equal(result.selected.url, `https://doi.org/${doi}`);
	assert.deepEqual(result.selected.authors, ['A Researcher']);
	assert.equal(result.selected.year, 2025);
	assert.equal(result.searchLimit, 20);
});

test('normalization handles publisher inline markup and typography, but not arbitrary approximation', async () => {
	assert.equal(normalizeTitle('  A <i>model</i> &amp; its \u201cdata\u201d. '), 'a model & its "data"');
	assert.equal((await resolvePaper(title, { fetchImpl: fetchItems([work(title.replace('graph-based', 'graph\u2013based') + '.')]) })).status, 'resolved');
	assert.equal((await resolvePaper(title, { fetchImpl: fetchItems([work(title.replace('graph-based', 'graph based'))]) })).status, 'needs-selection');
});

test('same title under two DOIs, short title, duplicates, and invalid records require selection', async () => {
	for (const [query, items] of [
		[title, [work(), work(title, '10.1234/second')]],
		['Novae', [work('Novae')]],
		[title, [work(), work()]],
		[title, [work(), work(title, null)]],
		[title, [work(), { ...work(), type: 'book' }]],
	]) {
		const result = await resolvePaper(query, { fetchImpl: fetchItems(items) });
		assert.equal(result.status, 'needs-selection');
		assert.equal(result.selected, null);
	}
});

test('empty results are not-found; invalid records are not evidence of absence', async () => {
	assert.equal((await resolvePaper(title, { fetchImpl: fetchItems([]) })).status, 'not-found');
	const result = await resolvePaper(title, { fetchImpl: fetchItems([{}]) });
	assert.equal(result.status, 'needs-selection');
	assert.equal(result.invalidRecords, 1);
});

test('search is bounded, sends only explicit contact data, and encodes query parameters', async () => {
	for (const mailto of [undefined, 'chosen@example.org']) {
		await resolvePaper('A paper: input & query.title=other / results', { mailto, fetchImpl: async (url, config) => {
			assert.equal(url.origin, 'https://api.crossref.org');
			assert.equal(url.searchParams.get('query.title'), 'A paper: input & query.title=other / results');
			assert.equal(url.searchParams.get('rows'), '20');
			assert.equal(url.searchParams.get('filter'), 'type:journal-article');
			assert.equal(url.searchParams.get('mailto'), mailto ?? null);
			assert.equal(config.redirect, 'error');
			assert.ok(config.signal instanceof AbortSignal);
			assert.equal(config.headers.Cookie, undefined);
			return response([]);
		} });
	}
});

test('service failures and rate limits remain errors without retries or paper selection', async () => {
	for (const status of [429, 503]) {
		let calls = 0;
		await assert.rejects(resolvePaper(title, { fetchImpl: async () => {
			calls++; return new Response('Unavailable', { status, headers: { 'retry-after': '60' } });
		} }), error => error.code === (status === 429 ? 'resolver-rate-limited' : 'resolver-http-error') && error.retryAfter === '60');
		assert.equal(calls, 1);
	}
});

test('malformed, non-JSON and oversized responses fail closed', async () => {
	for (const make of [
		() => new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }),
		() => new Response('{', { headers: { 'content-type': 'application/json' } }),
		() => new Response('{}', { headers: { 'content-type': 'application/json' } }),
		() => response(Array.from({ length: 21 }, () => work())),
		() => new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
	]) await assert.rejects(resolvePaper(title, { fetchImpl: async () => make() }));
});

test('timeout signal bounds network work and invalid settings fail before fetch', async () => {
	await assert.rejects(resolvePaper(title, { timeout: 10, fetchImpl: async (_url, { signal }) => {
		await delay(200, undefined, { signal }); return response([]);
	} }), { name: 'AbortError' });
	for (const settings of [{ timeout: 0 }, { timeout: Infinity }, { mailto: 'not-an-email' }]) {
		await assert.rejects(resolvePaper(title, { ...settings, fetchImpl: () => assert.fail('Invalid settings must not fetch') }));
	}
});
