// Public synthetic text only. No publisher captures or institutional content.
export const reviewUrl = 'https://www.nature.com/articles/synthetic-review';
export const reviewDoi = '10.1234/synthetic-review';
export const reviewParagraphs = [
	'Independent observations describe how sample organization varies across controlled experimental conditions. '.repeat(60).trim(),
	'The review compares multiple interpretations and identifies limitations for future experimental studies. '.repeat(60).trim(),
];
export const reviewMarkdown = `## Main\n\n${reviewParagraphs.join('\n\n')}\n`;
export const reviewHtml = `<!doctype html><html><head><title>Synthetic review</title>
<meta name="dc.type" content="ReviewPaper"><meta name="citation_doi" content="${reviewDoi}">
<meta name="citation_title" content="Synthetic review"></head><body>
<article class="c-article-body"><h1>Synthetic review</h1><div class="main-content">
<section data-title="Main"><div><h2 class="c-article-section__title">Main</h2>
<div class="c-article-section__content">${reviewParagraphs.map(text => `<p>${text}</p>`).join('')}</div>
</div></section></div></article></body></html>`;
