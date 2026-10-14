import { prepareMath } from './paper-math.mjs';

const descriptionSelector = 'figure .c-article-section__figure-description';
const citationSelector = '.reference-citations a.reference-citations__ctrl[data-xml-rid]';
const cellLegendSelector = 'figure.graphic figcaption .figure__caption__text__content';
const bibliographySelector = '.biblioentry .citations[id]';
const extendedImageSelector = '.c-article-supplementary__item h3 a[data-supp-info-image]';

function prepareCellFigures(document: Document): void {
	for (const legend of Array.from(document.querySelectorAll(cellLegendSelector))) {
		const figure = legend.closest('figure');
		if (!figure?.querySelector('img') || !legend.textContent?.trim()) continue;
		// The caption is already in the source, inside a collapsed accordion.
		// Move only its scientific content out of the hidden UI on our copy.
		const content = document.createElement('div');
		// Use Defuddle's extractor-content marker only for this identified legend;
		// short scientific phrases containing "related" are not navigation.
		content.setAttribute('data-defuddle', 'true');
		content.append(...Array.from(legend.childNodes));
		figure.after(content);
		legend.closest('.accordion')?.remove();
		legend.remove();
	}
}

function prepareCellBibliography(document: Document): void {
	for (const entry of Array.from(document.querySelectorAll(bibliographySelector))) {
		if (!/^bib\d+$/.test(entry.id) || !entry.querySelector('.citation-content')) continue;
		const citation = entry.cloneNode(true) as Element;
		citation.querySelector('.citation-content > .label')?.remove();
		// Defuddle emits multiline footnotes without continuation indentation.
		// A bibliography entry can be one rich paragraph without losing its links.
		for (const block of Array.from(citation.querySelectorAll('div, p')).reverse()) {
			block.replaceWith(...Array.from(block.childNodes), document.createTextNode(' '));
		}
		const paragraph = document.createElement('p');
		paragraph.append(...Array.from(citation.childNodes));
		entry.replaceChildren(paragraph);
	}
}

function prepareNatureExtendedImages(document: Document, url: string): void {
	const article = new URL(url);
	for (const link of Array.from(document.querySelectorAll(extendedImageSelector))) {
		const item = link.closest('.c-article-supplementary__item')!;
		try {
			const target = new URL(link.getAttribute('href') ?? '', article);
			const image = new URL(link.getAttribute('data-supp-info-image')!, article);
			if (!/^Extended Data Fig\.\s*\d+\b/i.test(link.textContent?.trim() ?? '') ||
				target.origin !== article.origin || !target.pathname.startsWith(`${article.pathname.replace(/\/$/, '')}/figures/`) ||
				image.protocol !== 'https:' || image.hostname !== 'media.springernature.com' || image.port || image.username || image.password ||
				!/^\/(?:lw\d+|full)\/springer-static\/(?:image|esm)\/.+\/MediaObjects\/.+\.(?:png|jpe?g|webp)$/i.test(image.pathname)) continue;
			if (!item.querySelector('img')) {
				const figure = document.createElement('figure');
				const img = document.createElement('img');
				img.src = image.href;
				img.alt = link.textContent?.trim() ?? '';
				figure.appendChild(img);
				link.closest('h3')!.after(figure);
			}
			link.removeAttribute('data-supp-info-image');
		} catch { /* Leave unfamiliar links intact, without inventing image URLs. */ }
	}
}

function prepareCellCitations(document: Document): void {
	for (const wrapper of Array.from(document.querySelectorAll('.reference-citations'))) {
		const controls = Array.from(wrapper.children).filter(child => child.matches('a.reference-citations__ctrl'));
		const holders = Array.from(wrapper.children).filter(child => child.matches('.dropBlock__holder'));
		if (controls.length !== 1 || holders.length !== 1) continue;
		const control = controls[0], holder = holders[0];
		const target = control.getAttribute('data-xml-rid');
		if (!target || !/^bib\d+$/.test(target) || !/^\d+$/.test(control.textContent?.trim() ?? '') ||
			!holder.id || (control.getAttribute('aria-controls') !== holder.id && control.getAttribute('data-db-target-for') !== holder.id) ||
			!holder.querySelector('.citation-content')) continue;

		// Cell stores a duplicate reference preview beside each inline marker.
		// Restore its bibliography link before Defuddle sees the hidden block content.
		const link = document.createElement('a');
		link.setAttribute('href', `#${target}`);
		if (control.id) link.id = control.id;
		link.append(...Array.from(control.childNodes));
		control.replaceWith(link);
		holder.remove();
		wrapper.replaceWith(...Array.from(wrapper.childNodes));
	}
}

export function prepareDocumentForExtraction(document: Document, url: string): Document {
	if (document.querySelector('mjx-container')) {
		document = document.cloneNode(true) as Document;
		prepareMath(document);
	}
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch { return document; }
	if (/(^|\.)cell\.com$/.test(hostname)) {
		if (!document.querySelector([citationSelector, cellLegendSelector, `${bibliographySelector} .citation-content`].join(', '))) return document;
		const prepared = document.cloneNode(true) as Document;
		prepareCellCitations(prepared);
		prepareCellFigures(prepared);
		prepareCellBibliography(prepared);
		return prepared;
	}
	if (!/(^|\.)nature\.com$/.test(hostname)) return document;
	if (!document.querySelector(`${descriptionSelector}, ${extendedImageSelector}`)) return document;
	const prepared = document.cloneNode(true) as Document;
	prepareNatureExtendedImages(prepared, url);
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
