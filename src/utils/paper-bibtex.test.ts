import { describe, expect, it } from 'vitest';
import { extractCitationFields, formatBibtex } from './paper-bibtex';

describe('paper BibTeX generation', () => {
	it('formats a full journal article from Highwire/Prism metadata and keeps DOI verbatim', () => {
		const bib = formatBibtex({
			title: 'Ignored page title',
			source: 'https://www.nature.com/articles/s41592-025-02899-6#Sec1',
			metaTags: [
				{ name: 'citation_title', content: 'A graph-based foundation model for spatial transcriptomics' },
				{ name: 'citation_author', content: 'Blampey, Quentin' },
				{ name: 'citation_author', content: 'Benkirane, Hakim' },
				{ name: 'citation_author', content: 'Blampey, Quentin' },
				{ name: 'citation_journal_title', content: 'Nature Methods' },
				{ name: 'citation_publication_date', content: '2025/11/03' },
				{ name: 'citation_volume', content: '22' },
				{ name: 'citation_issue', content: '11' },
				{ name: 'citation_firstpage', content: '100' },
				{ name: 'citation_lastpage', content: '112' },
				{ name: 'citation_publisher', content: 'Nature Publishing Group UK' },
				{ name: 'citation_issn', content: '1548-7105' },
				{ name: 'citation_doi', content: 'https://doi.org/10.1038/s41592-025-02899-6_test' },
			],
		});

		expect(bib).toBe([
			'@article{blampey2025graph,',
			'  title = {A graph-based foundation model for spatial transcriptomics},',
			'  author = {Blampey, Quentin and Benkirane, Hakim},',
			'  journal = {Nature Methods},',
			'  year = {2025},',
			'  volume = {22},',
			'  number = {11},',
			'  pages = {100--112},',
			'  publisher = {Nature Publishing Group UK},',
			'  issn = {1548-7105},',
			'  doi = {10.1038/s41592-025-02899-6_test},',
			'  url = {https://www.nature.com/articles/s41592-025-02899-6},',
			'}',
			'',
		].join('\n'));
	});

	it('formats conference proceedings as @inproceedings and strips diacritics in the citation key', () => {
		const fields = extractCitationFields({
			source: 'https://proceedings.example.org/paper',
			metaTags: [
				{ name: 'citation_title', content: 'The Müller & Co. 50% benchmark: {DNA} & RNA' },
				{ name: 'citation_author', content: 'José García' },
				{ name: 'citation_conference_title', content: 'International Conference on Machine Learning' },
				{ name: 'citation_date', content: '2024' },
				{ name: 'citation_firstpage', content: '42' },
			],
		});
		expect(fields.entryType).toBe('inproceedings');
		expect(fields.key).toBe('garcia2024muller');
		expect(fields.pages).toBe('42');

		const bib = formatBibtex({
			source: 'https://proceedings.example.org/paper',
			metaTags: [
				{ name: 'citation_title', content: 'The Müller & Co. 50% benchmark: {DNA} & RNA' },
				{ name: 'citation_author', content: 'José García' },
				{ name: 'citation_conference_title', content: 'International Conference on Machine Learning' },
				{ name: 'citation_date', content: '2024' },
				{ name: 'citation_firstpage', content: '42' },
			],
		});
		expect(bib).toContain('@inproceedings{garcia2024muller,');
		expect(bib).toContain('title = {The Müller \\& Co. 50\\% benchmark: \\{DNA\\} \\& RNA},');
		expect(bib).toContain('booktitle = {International Conference on Machine Learning},');
		expect(bib).toContain('pages = {42},');
	});

	it('falls back to @misc with title, author string, property DOI, and URL when journal tags are absent', () => {
		const bib = formatBibtex({
			title: 'Synthetic paper',
			author: 'Ada Lovelace; Charles Babbage',
			published: '2026-03-14',
			source: 'https://preprint.example.org/abs/1',
			properties: [{ name: 'doi', value: 'doi:10.1234/EXAMPLE_1' }],
		});
		expect(bib).toContain('@misc{lovelace2026synthetic,');
		expect(bib).toContain('author = {Ada Lovelace and Charles Babbage},');
		expect(bib).toContain('year = {2026},');
		expect(bib).toContain('doi = {10.1234/example_1},');
		expect(bib).toContain('url = {https://preprint.example.org/abs/1},');
	});

	it('uses paper fallback key and escapes special BibTeX characters without double-escaping backslashes', () => {
		const bib = formatBibtex({
			title: '100% $x_1$ ^ ~ \\test',
		});
		expect(bib).toContain('@misc{paper100,');
		expect(bib).toContain('title = {100\\% \\$x\\_1\\$ \\textasciicircum{} \\textasciitilde{} \\textbackslash{}test},');
		expect(bib.endsWith('\n')).toBe(true);
	});
});
