import { parseHTML } from 'linkedom';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

export function normalizeDoi(value) {
	if (!value) return null;
	let doi = clean(value).replace(/^doi:\s*/i, '');
	if (/^https?:\/\//i.test(doi)) {
		const url = new URL(doi);
		if (!/^(?:dx\.)?doi\.org$/i.test(url.hostname)) throw new Error('DOI URL must use doi.org.');
		doi = decodeURIComponent(url.pathname.slice(1));
	}
	if (!/^10\.\d{4,9}\/[^\s<>"#?]+$/i.test(doi)) throw new Error(`Invalid DOI: ${value}`);
	return doi.toLowerCase();
}

export function canonicalUrl(value) {
	const url = new URL(value);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Source must be HTTP(S) without credentials.');
	url.hash = '';
	for (const key of [...url.searchParams.keys()]) if (/^utm_|^(?:fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
	url.searchParams.sort();
	return url.href;
}

export function assessPaperIdentity(html, expectedDoi) {
	const expected = normalizeDoi(expectedDoi);
	if (!expected) throw new Error('An expected DOI is required for identity verification.');
	const document = parseHTML(html).document;
	const values = [...document.querySelectorAll('meta[content]')].filter(meta => {
		const name = (meta.getAttribute('name') || meta.getAttribute('property') || '').toLowerCase();
		return ['citation_doi', 'prism.doi'].includes(name) || name === 'dc.identifier' && /^(?:doi:|10\.|https?:\/\/(?:dx\.)?doi\.org\/)/i.test(meta.getAttribute('content').trim());
	}).map(meta => meta.getAttribute('content'));
	try {
		const actual = [...new Set(values.map(normalizeDoi).filter(Boolean))];
		return { expected, actual, status: actual.length === 1 && actual[0] === expected ? 'passed' : 'failed',
			reason: !actual.length ? 'missing-publisher-doi' : actual.length > 1 ? 'conflicting-publisher-dois' : actual[0] !== expected ? 'different-publisher-doi' : 'publisher-doi-match' };
	} catch (error) { return { expected, actual: [], status: 'failed', reason: 'invalid-publisher-doi', error: error.message }; }
}

export function paperMetadata(html, { url, capturedAt = null, convertedAt = null } = {}) {
	const document = parseHTML(html).document;
	const fields = new Map();
	for (const meta of document.querySelectorAll('meta[content]')) {
		const name = (meta.getAttribute('name') || meta.getAttribute('property') || '').toLowerCase();
		const value = clean(meta.getAttribute('content'));
		if (value) fields.set(name, [...fields.get(name) ?? [], value]);
	}
	const get = name => fields.get(name) ?? [];
	const unique = values => [...new Set(values)];
	const titles = unique(get('citation_title'));
	if (titles.length > 1) throw new Error('Conflicting citation titles in captured HTML.');
	const title = titles[0] || get('dc.title')[0] || clean(document.querySelector('h1')?.textContent);
	if (!title) throw new Error('No article title found in captured HTML.');
	const doiValues = [...get('citation_doi'), ...get('prism.doi'), ...get('dc.identifier').filter(value => /^(?:doi:|10\.|https?:\/\/(?:dx\.)?doi\.org\/)/i.test(value))];
	const dois = unique(doiValues.map(normalizeDoi));
	if (dois.length > 1) throw new Error('Conflicting article DOI metadata in captured HTML.');
	const source = canonicalUrl(url);
	const doiUrl = /^(?:dx\.)?doi\.org$/i.test(new URL(source).hostname) ? normalizeDoi(source) : null;
	if (doiUrl && dois[0] && doiUrl !== dois[0]) throw new Error('Source DOI URL conflicts with article DOI metadata.');
	const doi = dois[0] || doiUrl;
	const authors = unique(get('citation_author').length ? get('citation_author') : get('dc.creator'));
	const publicationDate = get('citation_publication_date')[0] || get('citation_date')[0] || get('dc.date')[0] || null;
	const year = /^(?:19|20)\d{2}\b/.test(publicationDate ?? '') ? Number(publicationDate.slice(0, 4)) : null;
	const journal = get('citation_journal_title')[0] || null;
	const captured = capturedAt && Number.isFinite(Date.parse(capturedAt)) ? new Date(capturedAt).toISOString() : null;
	const converted = convertedAt && Number.isFinite(Date.parse(convertedAt)) ? new Date(convertedAt).toISOString() : null;
	const gaps = [];
	if (!doi) gaps.push('doi');
	if (!authors.length) gaps.push('authors');
	if (!year) gaps.push('year');
	if (!journal) gaps.push('journal');
	if (!captured) gaps.push('captured_at');
	if (!titles.length && !get('dc.title').length) gaps.push('publisher_title_metadata');
	return { title, authors, year, doi, journal, source, publication_date: publicationDate,
		captured_at: captured, converted_at: converted, metadata_gaps: gaps,
		metadata_source: 'captured-publisher-html', identity: doi ? `doi:${doi}` : `url:${source}` };
}
