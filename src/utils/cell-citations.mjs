// Recognize only a Cell citation control bound to its own reference preview.
export function cellCitation(wrapper) {
	const controls = Array.from(wrapper.children).filter(child => child.matches('a.reference-citations__ctrl'));
	const holders = Array.from(wrapper.children).filter(child => child.matches('.dropBlock__holder'));
	if (controls.length !== 1 || holders.length !== 1) return null;
	const control = controls[0], holder = holders[0];
	const target = control.getAttribute('data-xml-rid');
	const label = control.textContent?.trim() ?? '';
	const authorYear = /(?:^|[\s,(\[])(?:18|19|20)\d{2}[a-z]?[)\]]?$/.test(label);
	if (!target || !/^bib\d+$/.test(target) || (!/^\d+$/.test(label) && !authorYear) ||
		!holder.id || (control.getAttribute('aria-controls') !== holder.id && control.getAttribute('data-db-target-for') !== holder.id) ||
		!holder.querySelector('.citation-content')) return null;
	return { control, holder, target, label, authorYear };
}

// Build the expected scientific caption on a copy. The footnote number must
// come from an independently matched, complete bibliography definition.
export function cellCaptionForCheck(paragraph, referenceNumbers) {
	const copy = paragraph.cloneNode(true);
	for (const wrapper of Array.from(copy.querySelectorAll('.reference-citations'))) {
		const citation = cellCitation(wrapper);
		const number = citation && referenceNumbers.get(citation.target);
		if (!citation || !number) continue; // Unresolved source still fails comparison.
		const link = copy.ownerDocument.createElement('a');
		link.setAttribute('href', `#${citation.target}`);
		link.textContent = `${citation.authorYear ? citation.label : ''}${number}`;
		wrapper.replaceWith(link);
	}
	return copy;
}
