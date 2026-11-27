import { normalizeDoi } from './paper-bundle';

export interface BibtexMetaTag {
	name?: string | null;
	property?: string | null;
	content: string | null;
}

export interface BibtexProperty {
	name: string;
	value: unknown;
}

export interface PaperBibtexInput {
	title?: string;
	author?: string;
	published?: string;
	source?: string;
	doi?: string | null;
	metaTags?: BibtexMetaTag[];
	properties?: BibtexProperty[];
}

export interface CitationFields {
	entryType: 'article' | 'inproceedings' | 'misc';
	key: string;
	title: string;
	authors: string[];
	journal?: string;
	booktitle?: string;
	year?: string;
	volume?: string;
	number?: string;
	pages?: string;
	publisher?: string;
	issn?: string;
	doi?: string;
	url?: string;
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'to', 'with', 'and']);
const PROSE_ESCAPES: Record<string, string> = {
	'\\': '\\textbackslash{}',
	'{': '\\{',
	'}': '\\}',
	'%': '\\%',
	'&': '\\&',
	'#': '\\#',
	'_': '\\_',
	'$': '\\$',
	'~': '\\textasciitilde{}',
	'^': '\\textasciicircum{}',
};

function clean(value: unknown): string {
	return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function metaByNames(metaTags: BibtexMetaTag[], names: string[]): string[] {
	const map = new Map<string, string[]>();
	for (const tag of metaTags) {
		const key = (tag.name ?? tag.property ?? '').trim().toLowerCase();
		const value = clean(tag.content);
		if (!key || !value) continue;
		const list = map.get(key) ?? [];
		list.push(value);
		map.set(key, list);
	}
	for (const name of names) {
		const values = map.get(name);
		if (values?.length) return values;
	}
	return [];
}

function firstMeta(metaTags: BibtexMetaTag[], names: string[]): string | undefined {
	return metaByNames(metaTags, names)[0];
}

function propertyValue(properties: BibtexProperty[], name: string): string | undefined {
	const found = properties.find(prop => prop.name.trim().toLowerCase() === name);
	const value = clean(found?.value);
	return value || undefined;
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (value && !seen.has(value)) {
			seen.add(value);
			result.push(value);
		}
	}
	return result;
}

function extractYear(candidates: (string | undefined)[]): string | undefined {
	for (const candidate of candidates) {
		if (!candidate) continue;
		const match = candidate.match(/\b((?:1[0-9]|20)\d{2})\b/);
		if (match) return match[1];
	}
	return undefined;
}

function asciiSlug(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '');
}

function authorSurname(author: string): string {
	const trimmed = author.trim();
	if (!trimmed) return '';
	if (trimmed.includes(',')) {
		return asciiSlug(trimmed.split(',')[0]);
	}
	const parts = trimmed.split(/\s+/);
	return asciiSlug(parts[parts.length - 1] ?? '');
}

function firstSignificantTitleWord(title: string): string {
	const words = title
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	return words.find(word => !STOP_WORDS.has(word)) ?? words[0] ?? '';
}

function buildCitationKey(authors: string[], year: string | undefined, title: string): string {
	const surname = authors.length ? authorSurname(authors[0]) : '';
	const prefix = surname || 'paper';
	const word = firstSignificantTitleWord(title);
	const key = `${prefix}${year ?? ''}${word}`;
	return key || 'paper';
}

function escapeBibtexProse(value: string): string {
	return value.replace(/[\\{}%&#_$~^]/g, ch => PROSE_ESCAPES[ch] ?? ch);
}

function escapeBibtexVerbatim(value: string): string {
	return value.replace(/[{}]/g, ch => (ch === '{' ? '\\{' : '\\}'));
}

export function extractCitationFields(input: PaperBibtexInput): CitationFields {
	const metaTags = input.metaTags ?? [];
	const properties = input.properties ?? [];

	const title = firstMeta(metaTags, ['citation_title', 'dc.title']) || clean(input.title) || 'Untitled';

	let authors = uniqueStrings(metaByNames(metaTags, ['citation_author']));
	if (!authors.length) authors = uniqueStrings(metaByNames(metaTags, ['dc.creator']));
	if (!authors.length && input.author) {
		authors = uniqueStrings(input.author.split(/[;\n]+/).map(part => clean(part)).filter(Boolean));
	}

	const journal = firstMeta(metaTags, ['citation_journal_title', 'prism.publicationname', 'citation_journal_abbrev']);
	const booktitle = journal ? undefined : firstMeta(metaTags, ['citation_conference_title', 'citation_inbook_title']);
	const entryType: CitationFields['entryType'] = journal ? 'article' : booktitle ? 'inproceedings' : 'misc';

	const year = extractYear([
		firstMeta(metaTags, ['citation_publication_date']),
		firstMeta(metaTags, ['citation_date']),
		firstMeta(metaTags, ['citation_online_date']),
		firstMeta(metaTags, ['prism.publicationdate']),
		firstMeta(metaTags, ['dc.date']),
		clean(input.published) || undefined,
		propertyValue(properties, 'published'),
	]);

	const volume = firstMeta(metaTags, ['citation_volume', 'prism.volume']);
	const number = firstMeta(metaTags, ['citation_issue', 'prism.number']);

	const firstPage = firstMeta(metaTags, ['citation_firstpage', 'prism.startingpage']);
	const lastPage = firstMeta(metaTags, ['citation_lastpage', 'prism.endingpage']);
	const pages = firstPage && lastPage && firstPage !== lastPage
		? `${firstPage}--${lastPage}`
		: firstPage || undefined;

	const publisher = firstMeta(metaTags, ['citation_publisher', 'dc.publisher']);
	const issn = firstMeta(metaTags, ['citation_issn', 'prism.issn']);

	const doiCandidates = [
		input.doi,
		...metaByNames(metaTags, ['citation_doi', 'prism.doi', 'dc.identifier', 'dc.identifier.doi']),
		propertyValue(properties, 'doi'),
	];
	let doi: string | undefined;
	for (const candidate of doiCandidates) {
		const normalized = normalizeDoi(candidate);
		if (normalized) {
			doi = normalized;
			break;
		}
	}

	let url: string | undefined;
	if (input.source) {
		try {
			const parsed = new URL(input.source);
			if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
				parsed.hash = '';
				for (const key of [...parsed.searchParams.keys()]) {
					if (/^(?:utm_|fbclid$|gclid$)/i.test(key)) parsed.searchParams.delete(key);
				}
				url = parsed.href;
			}
		} catch { /* Leave invalid source URLs unset. */ }
	}

	return {
		entryType,
		key: buildCitationKey(authors, year, title),
		title,
		authors,
		...(journal ? { journal } : {}),
		...(booktitle ? { booktitle } : {}),
		...(year ? { year } : {}),
		...(volume ? { volume } : {}),
		...(number ? { number } : {}),
		...(pages ? { pages } : {}),
		...(publisher ? { publisher } : {}),
		...(issn ? { issn } : {}),
		...(doi ? { doi } : {}),
		...(url ? { url } : {}),
	};
}

export function formatBibtex(input: PaperBibtexInput): string {
	const fields = extractCitationFields(input);
	const lines: string[] = [`@${fields.entryType}{${fields.key},`];
	const pushProse = (name: string, value?: string) => {
		if (value) lines.push(`  ${name} = {${escapeBibtexProse(value)}},`);
	};
	const pushVerbatim = (name: string, value?: string) => {
		if (value) lines.push(`  ${name} = {${escapeBibtexVerbatim(value)}},`);
	};

	pushProse('title', fields.title);
	if (fields.authors.length) {
		lines.push(`  author = {${fields.authors.map(escapeBibtexProse).join(' and ')}},`);
	}
	pushProse('journal', fields.journal);
	pushProse('booktitle', fields.booktitle);
	pushVerbatim('year', fields.year);
	pushVerbatim('volume', fields.volume);
	pushVerbatim('number', fields.number);
	pushVerbatim('pages', fields.pages);
	pushProse('publisher', fields.publisher);
	pushVerbatim('issn', fields.issn);
	pushVerbatim('doi', fields.doi);
	pushVerbatim('url', fields.url);
	lines.push('}');
	return lines.join('\n') + '\n';
}
