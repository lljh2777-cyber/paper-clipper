import { MathMLToLaTeX } from 'mathml-to-latex';
import { prepareMath } from './paper-math.mjs';
import { cellCitation } from './cell-citations.mjs';
import { citationPublicationDay } from './publication-date';
import { preprintArticleSelector, prepareHighWirePreprint } from './biorxiv';
import { isHighWirePreprintHost } from './image-sources.mjs';

const descriptionSelector = 'figure .c-article-section__figure-description';
const citationSelector = '.reference-citations a.reference-citations__ctrl[data-xml-rid]';
const cellLegendSelector = 'figure.graphic figcaption .figure__caption__text__content';
const bibliographySelector = '.biblioentry .citations[id]';
const extendedImageSelector = '.c-article-supplementary__item h3 a[data-supp-info-image]';
const springerNatureHost = /(^|\.)nature\.com$|^link\.springer\.com$|(^|\.)biomedcentral\.com$/;

function springerFullSizeLinks(document: Document): Element[] {
	return Array.from(document.querySelectorAll('figure .c-article-section__figure-link'))
		.filter(box => Boolean(box.querySelector('a[data-track-action="view figure"]')) && /^Full size image$/i.test(box.textContent?.trim() ?? ''));
}

function springerRecommendationSections(document: Document): Element[] {
	return Array.from(document.querySelectorAll('section.c-article-recommendations'))
		.filter(section => /Similar content being viewed by others/i.test(section.querySelector('h2, h3')?.textContent ?? ''));
}

function springerSupplementaryLinks(document: Document, url: string): Array<{ heading: Element; href: string; label: string }> {
	const results: Array<{ heading: Element; href: string; label: string }> = [];
	for (const link of Array.from(document.querySelectorAll('.c-article-supplementary__item h3 a[data-test="supp-info-link"][href]'))) {
		if ((link.getAttribute('data-supp-info-image') ?? '').trim()) continue;
		const heading = link.closest('h3');
		if (!heading || heading.textContent?.trim() !== link.textContent?.trim()) continue;
		try {
			const target = new URL(link.getAttribute('href')!, url);
			if (!/^https?:$/.test(target.protocol) || target.username || target.password) continue;
			const clone = link.cloneNode(true) as Element;
			clone.querySelectorAll('svg').forEach(node => node.remove());
			const label = (clone.textContent ?? '').replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
			if (!label) continue;
			results.push({ heading, href: target.href, label });
		} catch { /* Ignore invalid supplementary URLs. */ }
	}
	return results;
}

function springerPunctuationEmphasis(document: Document): Element[] {
	return Array.from(document.querySelectorAll('.c-article-body i, .c-article-body em, .c-article-body b, .c-article-body strong'))
		.filter(el => {
			if (el.children.length || el.closest('pre, code, math, .mathjax-tex, mjx-container')) return false;
			const value = el.textContent ?? '';
			return Boolean(value) && /^[.,;:()[\]{}\s]+$/.test(value);
		});
}

function springerReferenceOrdinals(document: Document): Map<string, string> {
	const map = new Map<string, string>();
	let index = 0;
	for (const li of Array.from(document.querySelectorAll('.c-article-references > li'))) {
		index++;
		const id = li.id || Array.from(li.children).find(child => child.tagName === 'P' && /^ref-CR\d+$/.test(child.id))?.id;
		if (id) map.set(id, String(index));
	}
	return map;
}

function springerAuthorYearCitations(document: Document): Element[] {
	return Array.from(document.querySelectorAll('a[data-test="citation-ref"][href*="#ref-CR"]')).filter(link => {
		if (link.querySelector('sup')) return false;
		const match = link.getAttribute('href')?.match(/#ref-CR(\d+)$/);
		const label = link.textContent?.trim() ?? '';
		return Boolean(match && label !== match[1] && /^\d{4}[a-z]?$/.test(label));
	});
}

function springerTableLinks(document: Document, url: string): Array<{ box: Element; figure: Element; href: string; text: string }> {
	const results: Array<{ box: Element; figure: Element; href: string; text: string }> = [];
	for (const box of Array.from(document.querySelectorAll('.c-article-table'))) {
		const figure = box.querySelector('figure');
		const hideWrapper = box.querySelector('.u-hide-print');
		const link = hideWrapper?.querySelector('a[data-test="table-link"][href]');
		const label = link?.textContent?.trim() ?? '';
		if (!figure || !hideWrapper || !link || !label) continue;
		try {
			const target = new URL(link.getAttribute('href')!, url);
			if (!/^https?:$/.test(target.protocol) || target.username || target.password) continue;
			results.push({ box: hideWrapper, figure, href: target.href, text: label });
		} catch { /* Ignore invalid table URLs. */ }
	}
	return results;
}

function prepareMathJaxTex(getSource: () => Document, editable: () => Document): void {
	const delimiters: ReadonlyArray<readonly [string, string, 'inline' | 'block']> = [
		['\\(', '\\)', 'inline'],
		['\\[', '\\]', 'block'],
		['$$', '$$', 'block'],
	];
	const source = getSource();
	const candidateIndices: Array<{ index: number; display: 'inline' | 'block'; latex: string }> = [];
	const elements = Array.from(source.querySelectorAll('.mathjax-tex'));
	for (const [index, element] of elements.entries()) {
		if (element.children.length || element.closest('pre, code, script, style, textarea, math')) continue;
		const text = (element.textContent ?? '').trim();
		const delimiter = delimiters.find(([start, end]) => text.startsWith(start) && text.endsWith(end));
		if (!delimiter) continue;
		const [start, end, display] = delimiter;
		const latex = text.slice(start.length, -end.length).trim();
		if (!latex) continue;
		candidateIndices.push({ index, display, latex });
	}
	if (!candidateIndices.length) return;
	const doc = editable();
	const targetElements = Array.from(doc.querySelectorAll('.mathjax-tex'));
	for (const { index, display, latex } of candidateIndices) {
		const element = targetElements[index];
		if (!element) continue;
		// Static exports omit the library script that normally enables Defuddle's
		// raw-TeX detection. Mark only explicitly labelled publisher math as MathML.
		const math = doc.createElement('math');
		math.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
		math.setAttribute('display', display);
		math.setAttribute('data-latex', latex);
		math.textContent = latex;
		element.replaceChildren(math);
	}
}

function prepareMathMLForReader(getSource: () => Document, editable: () => Document): void {
	const source = getSource();
	const replacements: Array<{ index: number; latex: string }> = [];
	const mathElements = Array.from(source.querySelectorAll('math'));
	for (const [index, math] of mathElements.entries()) {
		if (math.closest('pre, code, script, style, textarea') || math.hasAttribute('data-latex') ||
			math.hasAttribute('alttext') || math.hasAttribute('data-math') ||
			math.querySelector('annotation, mlabeledtr') ||
			math.parentElement?.querySelector('script[type^="math/tex"]')) continue;
		const dots = Array.from(math.querySelectorAll('mo')).filter(node => node.textContent?.trim() === '\u22ef');
		const nested = math.querySelector('mtable mtable');
		if ((!dots.length && !nested) || math.textContent?.includes('\u2026')) continue;
		// mathml-to-latex emits unsupported \\hdots for U+22EF and flattens nested
		// tables later. Supply verified TeX while retaining the original MathML.
		const latex = MathMLToLaTeX.convert(math.outerHTML);
		const aliases = [...latex.matchAll(/\\hdots(?![a-zA-Z])/g)];
		if (aliases.length !== dots.length) continue;
		replacements.push({ index, latex: latex.replace(/\\hdots(?![a-zA-Z])/g, '\\cdots') });
	}
	if (!replacements.length) return;
	const doc = editable();
	const targetElements = Array.from(doc.querySelectorAll('math'));
	for (const { index, latex } of replacements) {
		targetElements[index]?.setAttribute('data-latex', latex);
	}
}

function prepareFrontiers(document: Document, url: string): void {
	for (const button of Array.from(document.querySelectorAll('.ArticleFigure button.ArticleFigure__figureButton'))) {
		if (!button.querySelector('figure')) continue;
		// Frontiers wraps both the figure and its caption inside a lightbox button.
		button.replaceWith(...Array.from(button.childNodes));
	}
	for (const link of Array.from(document.querySelectorAll('a.ArticleReference[href]'))) {
		const href = link.getAttribute('href');
		if (!href?.startsWith('#') || href.length === 1 || !link.textContent?.trim() || link.closest('pre, code')) continue;
		link.setAttribute('href', new URL(href, url).href);
		link.classList.remove('ArticleReference');
	}
}

function preparePlosReferences(document: Document, url: string): void {
	const targets = new Map<string, string>();
	for (const entry of Array.from(document.querySelectorAll('ol.references > li[id]'))) {
		const anchor = entry.querySelector(':scope > a.link-target[id]');
		const order = entry.querySelector(':scope > span.order');
		if (!anchor || !order || !/^\d+\.$/.test(order.textContent?.trim() ?? '')) continue;
		targets.set('#' + anchor.id, '#' + entry.id);
		order.remove();
		// PLOS mixes bare citation text with a list of lookup controls. Defuddle
		// copies only element children when rebuilding a footnote containing blocks.
		// Keep the citation inline, including its emphasis and real lookup links.
		for (const tools of Array.from(entry.querySelectorAll(':scope > ul.reflinks, :scope > ul.find-nolinks'))) {
			const links = Array.from(tools.querySelectorAll('a[href]')).filter(link => {
				const href = link.getAttribute('href')!.trim();
				if (!href || href.startsWith('#')) return false;
				try { return /^https?:$/.test(new URL(href, url).protocol); }
				catch { return false; }
			});
			tools.replaceWith(...links.flatMap(link => [document.createTextNode(' '), link]));
		}
		for (const paragraph of Array.from(entry.querySelectorAll(':scope > p'))) {
			paragraph.replaceWith(...Array.from(paragraph.childNodes), document.createTextNode(' '));
		}
	}
	for (const link of Array.from(document.querySelectorAll('a.ref-tip[href]'))) {
		const target = targets.get(link.getAttribute('href')!);
		if (!target || !/^\[?\d+\]?$/.test(link.textContent?.trim() ?? '')) continue;
		link.setAttribute('href', target);
		link.classList.remove('ref-tip');
	}
}

function preparePmc(document: Document): void {
	// Only remove the header byline when every displayed name is already in
	// citation metadata. Do not remove affiliations, author notes or body prose.
	const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
	const authors = new Set(Array.from(document.querySelectorAll('meta[name="citation_author"]'))
		.map(meta => normalize(meta.getAttribute('content') ?? '')).filter(Boolean));
	for (const group of Array.from(document.querySelectorAll('article > section[aria-label="Article citation and metadata"] .front-matter .ameta > .cg'))) {
		const names = Array.from(group.querySelectorAll(':scope > a > .name, :scope > .name')).map(name => normalize(name.textContent ?? ''));
		const remainder = group.cloneNode(true) as Element;
		remainder.querySelectorAll('a:has(.name), .name, sup, [hidden]').forEach(node => node.remove());
		if (names.length && names.every(name => authors.has(name)) && /^[\s,;]*$/.test(remainder.textContent ?? '')) group.remove();
	}
	for (const figure of Array.from(document.querySelectorAll('article figure.fig'))) {
		const titles = Array.from(figure.children).filter(el => el.matches('h2.obj_head, h3.obj_head, h4.obj_head, h5.obj_head, h6.obj_head'));
		if (titles.length !== 1 || !figure.querySelector('img') || !titles[0].textContent?.trim()) continue;
		// PMC puts the title outside figcaption. Defuddle rebuilds the figure
		// from its image and caption, so preserve this title as an adjacent block.
		const title = document.createElement('p');
		title.setAttribute('data-defuddle', 'true');
		if (titles[0].id) title.id = titles[0].id;
		title.append(...Array.from(titles[0].childNodes));
		figure.before(title);
		titles[0].remove();
		for (const control of Array.from(figure.children).filter(el => el.matches('.p.text-right'))) {
			const link = control.firstElementChild;
			if (control.children.length === 1 && link?.matches('a') && control.textContent?.trim() === 'Open in a new tab' &&
				figure.id && link.getAttribute('href') === `figure/${figure.id}/`) control.remove();
		}
		// Keep panel paragraphs, sub/superscripts and links as rich content.
		const caption = Array.from(figure.children).find(el => el.matches('figcaption'));
		if (caption) {
			const content = document.createElement('div');
			content.setAttribute('data-defuddle', 'true');
			content.append(...Array.from(caption.childNodes));
			figure.after(content);
			caption.remove();
		}
	}
}

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
		const citation = cellCitation(wrapper);
		if (!citation) continue;
		const { control, holder, target, authorYear } = citation;

		// Cell stores a duplicate reference preview beside each inline marker.
		// Restore its bibliography link before Defuddle sees the hidden block content.
		const link = document.createElement('a');
		link.setAttribute('href', `#${target}`);
		if (control.id) link.id = control.id;
		if (authorYear) {
			// Retain the author's label, adding a numeric marker for Defuddle's
			// existing footnote conversion. Do not expand the hidden preview.
			const label = document.createElement('span');
			label.append(...Array.from(control.childNodes));
			control.before(label);
			const marker = document.createElement('sup');
			marker.textContent = target.slice(3);
			link.append(marker);
		} else link.append(...Array.from(control.childNodes));
		control.replaceWith(link);
		holder.remove();
		wrapper.replaceWith(...Array.from(wrapper.childNodes));
	}
}

export function prepareDocumentForExtraction(source: Document, url: string): Document {
	let document = source;
	function editable(): Document {
		if (document === source) document = source.cloneNode(true) as Document;
		return document;
	}
	if (document.querySelector('mjx-container')) {
		prepareMath(editable());
	}
	prepareMathJaxTex(() => document, editable);
	prepareMathMLForReader(() => document, editable);
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch { return document; }
	// Defuddle reads Open Graph and schema.org dates, but skips Highwire
	// citation tags. Expose the publisher's calendar date on the parsing copy.
	if (!document.querySelector('head meta[property="article:published_time" i][content]:not([content=""])')) {
		const published = citationPublicationDay(document, hostname);
		if (published) {
			const copy = editable();
			const tag = copy.createElement('meta');
			tag.setAttribute('property', 'article:published_time');
			tag.setAttribute('content', published);
			copy.head.prepend(tag);
		}
	}
	if (isHighWirePreprintHost(hostname) && document.querySelectorAll(preprintArticleSelector).length === 1) {
		const prepared = editable();
		prepareHighWirePreprint(prepared, url);
		return prepared;
	}
	if (hostname === 'journals.plos.org' && document.querySelector('ol.references > li[id] > a.link-target[id]')) {
		const prepared = editable();
		preparePlosReferences(prepared, url);
		return prepared;
	}
	if (/(^|\.)frontiersin\.org$/.test(hostname)) {
		const hasLightbox = Array.from(document.querySelectorAll('.ArticleFigure button.ArticleFigure__figureButton'))
			.some(button => Boolean(button.querySelector('figure')));
		const hasArticleRef = Array.from(document.querySelectorAll('a.ArticleReference[href]'))
			.some(link => {
				const href = link.getAttribute('href');
				return Boolean(href?.startsWith('#') && href.length > 1 && link.textContent?.trim() && !link.closest('pre, code'));
			});
		if (!hasLightbox && !hasArticleRef) return document;
		const prepared = editable();
		prepareFrontiers(prepared, url);
		return prepared;
	}
	if (hostname === 'pmc.ncbi.nlm.nih.gov') {
		if (!document.querySelector('article .front-matter .ameta > .cg, article figure.fig .obj_head')) return document;
		const prepared = editable();
		preparePmc(prepared);
		return prepared;
	}
	if (/(^|\.)cell\.com$/.test(hostname)) {
		if (!document.querySelector([citationSelector, cellLegendSelector, `${bibliographySelector} .citation-content`].join(', '))) return document;
		const prepared = editable();
		prepareCellCitations(prepared);
		prepareCellFigures(prepared);
		prepareCellBibliography(prepared);
		return prepared;
	}
	if (!springerNatureHost.test(hostname)) return document;
	const hasSpringerChanges = Boolean(
		document.querySelector(`${descriptionSelector}, ${extendedImageSelector}, .c-article-header a[href^="#Aff"], a[data-track-action="equation anchor"][href*="#Equ"], ul.c-article-references`) ||
		springerAuthorYearCitations(document).length ||
		springerTableLinks(document, url).length ||
		springerFullSizeLinks(document).length ||
		springerRecommendationSections(document).length ||
		springerSupplementaryLinks(document, url).length ||
		springerPunctuationEmphasis(document).length
	);
	if (!hasSpringerChanges) return document;
	const prepared = editable();
	// On author-year SpringerLink/EMBO articles with UL references, header #Aff
	// links and equation anchors otherwise trigger Defuddle's generic footnote pass.
	for (const link of Array.from(prepared.querySelectorAll('.c-article-header a[href^="#Aff"], a[data-track-action="equation anchor"][href*="#Equ"]'))) {
		link.replaceWith(prepared.createTextNode(link.textContent ?? ''));
	}
	for (const emphasis of springerPunctuationEmphasis(prepared)) {
		emphasis.replaceWith(prepared.createTextNode(emphasis.textContent ?? ''));
	}
	// Convert unordered reference lists to <ol> with IDs on <li> so Defuddle preserves
	// numbered citations cleanly without turning equation/affiliation blocks into footnotes.
	for (const ul of Array.from(prepared.querySelectorAll('ul.c-article-references'))) {
		const ol = prepared.createElement('ol');
		for (const attr of Array.from(ul.attributes)) ol.setAttribute(attr.name, attr.value);
		for (const li of Array.from(ul.children)) {
			if (!li.id) {
				const p = Array.from(li.children).find(child => child.tagName === 'P' && /^ref-CR/.test(child.id));
				if (p) {
					li.id = p.id;
					p.removeAttribute('id');
				}
			}
			ol.append(li);
		}
		ul.replaceWith(ol);
	}
	const refOrdinals = springerReferenceOrdinals(prepared);
	for (const link of springerAuthorYearCitations(prepared)) {
		const match = link.getAttribute('href')?.match(/#(ref-CR(\d+))$/);
		const labelText = link.textContent?.trim() ?? '';
		if (!match || !labelText) continue;
		const label = prepared.createElement('span');
		label.textContent = labelText;
		link.before(label);
		const sup = prepared.createElement('sup');
		sup.textContent = refOrdinals.get(match[1]) ?? match[2];
		link.replaceChildren(sup);
	}
	for (const { box, figure, href, text: label } of springerTableLinks(prepared, url)) {
		const p = prepared.createElement('p');
		const anchor = prepared.createElement('a');
		anchor.setAttribute('href', href);
		anchor.textContent = label;
		p.append(anchor);
		figure.after(p);
		box.remove();
	}
	for (const linkBox of springerFullSizeLinks(prepared)) {
		linkBox.remove();
	}
	for (const section of springerRecommendationSections(prepared)) {
		section.remove();
	}
	for (const { heading, href, label } of springerSupplementaryLinks(prepared, url)) {
		const p = prepared.createElement('p');
		p.setAttribute('data-defuddle', 'true');
		const anchor = prepared.createElement('a');
		anchor.setAttribute('href', href);
		const download = label.match(/^(.+?)\s*\((download [^)]+)\)$/i);
		if (download) {
			const strong = prepared.createElement('strong');
			strong.textContent = download[1];
			anchor.textContent = download[2];
			p.append(strong, prepared.createTextNode(' ('), anchor, prepared.createTextNode(')'));
		} else {
			const strong = prepared.createElement('strong');
			anchor.textContent = label;
			strong.append(anchor);
			p.append(strong);
		}
		heading.replaceWith(p);
	}
	prepareNatureExtendedImages(prepared, url);
	for (const description of Array.from(prepared.querySelectorAll(descriptionSelector))) {
		const figure = description.closest('figure');
		if (!figure?.querySelector('img') || description.closest('figcaption') || !description.textContent?.trim()) continue;
		// A separator inside emphasis after a number produces invalid CommonMark
		// (7<i>, GENE</i> becomes 7*, GENE*). Keep the separator outside the
		// italic label on our copy, without changing text or the scientific value.
		for (const emphasis of Array.from(description.querySelectorAll('i, em'))) {
			const first = emphasis.firstChild;
			if (first?.nodeType !== 3) continue;
			const prefix = first.textContent?.match(/^[,;:]\s+/)?.[0];
			if (!prefix || !emphasis.textContent?.slice(prefix.length).trim()) continue;
			emphasis.before(prepared.createTextNode(prefix));
			first.textContent = first.textContent!.slice(prefix.length);
		}
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
