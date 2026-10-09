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
		// Defuddle replaces grouped citation superscripts with adjacent footnotes,
		// dropping separators. Keep the original separators between single refs.
		for (const sup of Array.from(description.querySelectorAll('sup'))) {
			const links = Array.from(sup.children);
			if (links.length < 2 || !links.every(link => {
				if (link.tagName !== 'A' || !link.hasAttribute('href')) return false;
				try {
					const target = new URL(link.getAttribute('href')!, url), article = new URL(url);
					return target.origin === article.origin && target.pathname === article.pathname &&
					/^#ref-CR\d+$/.test(target.hash) && link.textContent?.trim() === target.hash.slice(7);
				} catch { return false; }
			}) || Array.from(sup.childNodes).some(node => node.nodeType !== 1 && (node.nodeType !== 3 || !/^[\s,]*$/.test(node.textContent ?? '')))) continue;
			sup.replaceWith(...Array.from(sup.childNodes).map(node => {
				if (node.nodeType !== 1) return node;
				const reference = prepared.createElement('sup');
				reference.appendChild(node);
				return reference;
			}));
		}
		// Defuddle keeps only the first figcaption when rebuilding a figure.
		// Move Nature's separate legend after the figure, retaining its rich content.
		description.classList.remove('c-article-section__figure-description');
		figure.after(description);
	}
	return prepared;
}
