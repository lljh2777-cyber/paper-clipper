import { prepareMath } from './paper-math.mjs';

const descriptionSelector = 'figure .c-article-section__figure-description';
const citationSelector = '.reference-citations a.reference-citations__ctrl[data-xml-rid]';

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
		if (!document.querySelector(citationSelector)) return document;
		const prepared = document.cloneNode(true) as Document;
		prepareCellCitations(prepared);
		return prepared;
	}
	if (!/(^|\.)nature\.com$/.test(hostname)) return document;
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
