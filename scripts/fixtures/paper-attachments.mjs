export const source = 'https://journal.example.org/article';
export const pdfUrl = 'https://files.example.org/supplement.pdf?Signature=synthetic-secret';
export const csvUrl = 'https://files.example.org/table-s1.csv';
export const pdf = '%PDF-1.4\nSynthetic supplementary methods';
export const csv = 'sample,value\nA,10\nB,20\n';
export const html = `<!doctype html><html><head>
	<title>Synthetic supplementary paper</title><meta name="citation_doi" content="10.1234/attachments">
	<meta name="citation_publication_date" content="2026-10-22"></head><body><article>
	<h1>Synthetic supplementary paper</h1><p>${'The synthetic measurements compare independent samples under controlled conditions. '.repeat(50)}
	The article is available as <a href="https://files.example.org/article.pdf">Download PDF</a>.
	The methods and tabular measurements are available in
	<a href="${pdfUrl}">Supplementary methods and experimental protocol</a> and
	<a href="${csvUrl}">Supplementary Table S1: measurements</a>.</p>
	</article></body></html>`;
