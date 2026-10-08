import { parseHTML } from 'linkedom';
import { canonicalUrl, normalizeDoi } from './paper-metadata.mjs';

const searchLimit = 20;
const maxResponseBytes = 2 * 1024 * 1024;
const plain = value => typeof value === 'string' ? parseHTML(`<html><body>${value}</body></html>`).document.body.textContent.replace(/\s+/g, ' ').trim() : '';
export const normalizeTitle = value => plain(value).normalize('NFKC').toLowerCase()
	.replace(/[\u2010-\u2015]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\.$/, '').trim();
const doiUrl = doi => `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}`;

export function classifyQuery(value) {
	if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\x00-\x1f]/.test(value)) throw new Error('Provide one title, DOI or HTTP(S) URL, at most 1000 characters and without control characters.');
	const query = value.trim();
	if (/^(?:doi:|10\.\d{4,9}\/)/i.test(query)) {
		const doi = normalizeDoi(query);
		return { kind: 'doi', query, doi, url: doiUrl(doi) };
	}
	if (/^(?:https?:|[a-z][a-z0-9+.-]*:\/\/|file:|data:|javascript:|[a-z]:[\\/])/i.test(query)) {
		const url = canonicalUrl(query);
		if (/^(?:dx\.)?doi\.org$/i.test(new URL(url).hostname)) {
			const doi = normalizeDoi(url);
			return { kind: 'doi', query, doi, url: doiUrl(doi) };
		}
		return { kind: 'url', query, url, doi: null };
	}
	return { kind: 'title', query };
}

function candidate(item) {
	if (item?.type !== 'journal-article' || !Array.isArray(item.title) || !plain(item.title[0])) throw new Error('Incomplete journal-article metadata.');
	const doi = normalizeDoi(item.DOI);
	if (!doi) throw new Error('Missing DOI.');
	const year = (item.published?.['date-parts'] ?? item.issued?.['date-parts'])?.[0]?.[0];
	return { doi, title: plain(item.title[0]), url: doiUrl(doi), type: item.type,
		authors: (Array.isArray(item.author) ? item.author : []).map(author => plain(author.name || [author.given, author.family].filter(Boolean).join(' '))).filter(Boolean),
		journal: plain(item['container-title']?.[0]) || null, year: Number.isInteger(year) ? year : null };
}

async function search(query, { fetchImpl, timeout, mailto }) {
	const url = new URL('https://api.crossref.org/works');
	url.searchParams.set('query.title', query);
	url.searchParams.set('filter', 'type:journal-article');
	url.searchParams.set('rows', String(searchLimit));
	url.searchParams.set('select', 'DOI,title,author,published,issued,container-title,type');
	if (mailto) url.searchParams.set('mailto', mailto);
	const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeout), redirect: 'error',
		headers: { Accept: 'application/json', 'User-Agent': 'PaperClipper/0.1 (local title resolver)' } });
	if (!response.ok) {
		await response.body?.cancel();
		throw Object.assign(new Error(`Crossref returned HTTP ${response.status}. No paper was selected.`), { code: response.status === 429 ? 'resolver-rate-limited' : 'resolver-http-error', retryAfter: response.headers.get('retry-after') });
	}
	if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
		await response.body?.cancel();
		throw new Error('Crossref did not return JSON.');
	}
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		if (size > maxResponseBytes) throw new Error('Crossref response exceeds 2 MiB.');
		chunks.push(chunk);
	}
	const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
	if (data.status !== 'ok' || !Array.isArray(data.message?.items) || data.message.items.length > searchLimit) throw new Error('Invalid Crossref works response.');
	return data.message;
}

export async function resolvePaper(query, { fetchImpl = fetch, timeout = 15000, mailto } = {}) {
	const input = classifyQuery(query);
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) throw new Error('Resolver timeout must be a positive integer.');
	if (mailto && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailto)) throw new Error('--mailto must be an email address you choose to send to Crossref.');
	if (input.kind !== 'title') return { ...input, status: 'resolved', reason: 'explicit-identifier', provider: null,
		selected: { doi: input.doi, url: input.url, title: null }, candidates: [], metadataVerified: false };
	const data = await search(input.query, { fetchImpl, timeout, mailto });
	const candidates = [];
	let invalidRecords = 0;
	for (const item of data.items) {
		try { candidates.push(candidate(item)); } catch { invalidRecords++; }
	}
	const distinct = [...new Map(candidates.map(item => [item.doi, item])).values()];
	const exact = distinct.filter(item => normalizeTitle(item.title) === normalizeTitle(input.query));
	// Relevance ranking is not identity confidence. Short or approximate titles
	// and inconsistent records always require an explicit DOI selection.
	const automatic = exact.length === 1 && normalizeTitle(input.query).length >= 40 && !invalidRecords && distinct.length === candidates.length;
	return { ...input, status: automatic ? 'resolved' : distinct.length || invalidRecords ? 'needs-selection' : 'not-found',
		reason: automatic ? 'unique-exact-title-in-results' : exact.length > 1 ? 'multiple-exact-titles' : 'explicit-doi-required',
		provider: 'crossref', checkedAt: new Date().toISOString(), searchLimit, totalResults: data['total-results'] ?? null,
		invalidRecords, candidates: distinct, selected: automatic ? exact[0] : null, metadataVerified: automatic };
}
