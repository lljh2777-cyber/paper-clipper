const descriptionSelector = 'figure .c-article-section__figure-description';

export function prepareDocumentForExtraction(document: Document, url: string): Document {
	try {
		if (!/(^|\.)nature\.com$/.test(new URL(url).hostname)) return document;
	} catch { return document; }
	if (!document.querySelector(descriptionSelector)) return document;
	const prepared = document.cloneNode(true) as Document;
	for (const description of Array.from(prepared.querySelectorAll(descriptionSelector))) {
		const figure = description.closest('figure');
		if (!figure?.querySelector('img') || description.closest('figcaption') || !description.textContent?.trim()) continue;
		// Defuddle keeps only the first figcaption when rebuilding a figure.
		// Move Nature's separate legend after the figure, retaining its rich content.
		description.classList.remove('c-article-section__figure-description');
		figure.after(description);
	}
	return prepared;
}
