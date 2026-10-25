import { MathMLToLaTeX } from 'mathml-to-latex';
import { fromMarkdown } from 'mdast-util-from-markdown';

const excluded = 'pre, code, script, style, template, nav, header, footer, aside, .dropBlock__holder';
const transparent = new Set(['mjx-math', 'mjx-mrow', 'mjx-table', 'mjx-itable']);
const decoration = new Set(['mjx-tstrut', 'mjx-nstrut', 'mjx-dstrut', 'mjx-strut', 'mjx-break', 'mjx-spacer']);
const variants = new Set(['normal', 'italic', 'bold', 'bold-italic', 'double-struck', 'script', 'fraktur', 'sans-serif', 'monospace']);
const name = node => node.localName.toLowerCase();
const children = node => Array.from(node.children);
const fail = detail => { throw new Error(detail); };
const toLatex = math => MathMLToLaTeX.convert(math)
	.replace(/\\mathbf\{\\mathit\{([^{}]*)\}\}/g, '\\boldsymbol{$1}');

function reconstruct(root) {
	const doc = root.ownerDocument;
	const spaces = [];
	const element = (tag, nodes = []) => {
		const el = doc.createElement(tag);
		el.append(...nodes);
		return el;
	};
	const group = nodes => nodes.length === 1 ? nodes[0] : element('mrow', nodes);
	const parts = node => children(node).flatMap(convert);
	const direct = (node, tag) => children(node).filter(child => name(child) === tag);
	const one = (node, tag) => {
		const matches = direct(node, tag);
		if (matches.length !== 1) fail(`Ambiguous ${name(node)} / ${tag}`);
		return matches[0];
	};
	function convert(node) {
		const tag = name(node);
		if (decoration.has(tag)) {
			if (node.textContent?.trim() || node.children.length) fail(`Unexpected content in ${tag}`);
			return [];
		}
		if (!['mjx-mi', 'mjx-mo', 'mjx-mn', 'mjx-mtext'].includes(tag) &&
			Array.from(node.childNodes).some(child => child.nodeType === 3 && child.textContent?.trim())) fail(`Unexpected text in ${tag}`);
		if (transparent.has(tag)) return parts(node);
		if (['mjx-mi', 'mjx-mo', 'mjx-mn', 'mjx-mtext'].includes(tag)) {
			if (children(node).some(child => name(child) !== 'mjx-c')) fail(`Unsupported token: ${tag}`);
			const raw = node.textContent ?? '';
			if (!raw && children(node).length) fail('Font-only MathJax glyphs have no source text');
			const text = raw.normalize('NFKC').replace(/[\u2061-\u2064]/g, '');
			if (!text) return [];
			const el = element(tag.slice(4));
			el.textContent = text;
			// Some enriched trees label Unicode double-struck glyphs as "normal".
			const font = /^[\u2102\u210D\u2115\u2119\u211A\u211D\u2124]$/.test(raw) ? 'double-struck' : node.getAttribute('data-semantic-font');
			if (font && !variants.has(font)) fail(`Unsupported math font: ${font}`);
			if (font) el.setAttribute('mathvariant', font);
			// Without a font annotation, retain Unicode mathematical glyphs verbatim.
			else el.textContent = raw.replace(/[\u2061-\u2064]/g, '');
			return [el];
		}
		if (tag === 'mjx-mspace') {
			const width = node.style?.width || node.getAttribute('width');
			if (!width || !/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:em|ex|pt|px)$/.test(width)) fail('Unknown MathJax spacing');
			// mathml-to-latex drops mspace widths. Preserve explicit source spacing
			// with temporary tokens, then substitute only our generated tokens.
			const el = element('mi');
			el.textContent = `PCSPACE${spaces.length}END`;
			el.setAttribute('data-paper-space', 'true');
			spaces.push({ width, latex: `\\hspace{${width}}` });
			return [el];
		}
		if (tag === 'mjx-msub' || tag === 'mjx-msup' || tag === 'mjx-munderover') {
			const script = one(node, 'mjx-script');
			const base = children(node).filter(child => child !== script).flatMap(convert);
			const scripts = children(script).filter(child => !decoration.has(name(child)));
			if (!base.length || scripts.length !== (tag === 'mjx-munderover' ? 2 : 1)) fail(`Ambiguous ${tag} slots`);
			const prefix = [];
			while (base[0]?.hasAttribute('data-paper-space')) prefix.push(base.shift());
			if (!base.length) fail(`Empty ${tag} base`);
			const slots = scripts.map(child => group(convert(child)));
			// CHTML puts the upper limit first; MathML expects lower, then upper.
			if (tag === 'mjx-munderover') slots.reverse();
			return [...prefix, element(tag.slice(4), [group(base), ...slots])];
		}
		if (tag === 'mjx-mfrac') {
			const frac = one(node, 'mjx-frac');
			const num = one(frac, 'mjx-num');
			const box = one(frac, 'mjx-dbox');
			const table = one(box, 'mjx-dtable');
			const row = one(table, 'mjx-row');
			const den = one(row, 'mjx-den');
			if (children(frac).length !== 2 || children(box).length !== 1 ||
				children(table).some(child => !['mjx-line', 'mjx-row'].includes(name(child))) || children(row).length !== 1) fail('Unsupported fraction layout');
			const numerator = parts(num), denominator = parts(den);
			if (!numerator.length || !denominator.length) fail('Empty fraction slot');
			return [element('mfrac', [group(numerator), group(denominator)])];
		}
		if (['mjx-mtable', 'mjx-mtr', 'mjx-mtd'].includes(tag)) {
			const nodes = parts(node);
			if (tag !== 'mjx-mtd' && (!nodes.length || nodes.some(child => name(child) !== (tag === 'mjx-mtable' ? 'mtr' : 'mtd')))) fail(`Invalid ${tag} structure`);
			return [element(tag.slice(4), nodes)];
		}
		fail(`Unsupported MathJax element: ${tag}`);
	}
	if (/PCSPACE|PCGROUP/.test(root.textContent ?? '')) fail('Reserved formula token in source');
	const math = element('math', parts(root));
	if (!math.textContent?.trim()) fail('Empty rendered formula');
	const forLatex = math.cloneNode(true);
	// The library adds visible parentheses to grouped script bases. Source
	// grouping is not a request for parentheses; retain it using TeX braces.
	const grouped = [];
	for (const script of Array.from(forLatex.querySelectorAll('msub, msup')).reverse()) {
		const base = script.firstElementChild;
		if (base?.localName !== 'mrow') continue;
		const wrapper = element('math', [base.cloneNode(true)]);
		const token = element('mi');
		token.textContent = `PCGROUP${grouped.length}END`;
		grouped.push(`{${toLatex(wrapper.outerHTML)}}`);
		base.replaceWith(token);
	}
	let latex = toLatex(forLatex.outerHTML);
	for (const [index, tex] of [...grouped.entries()].reverse()) latex = latex.replaceAll(`PCGROUP${index}END`, tex);
	for (const [index, space] of spaces.entries()) latex = latex.replaceAll(`PCSPACE${index}END`, space.latex);
	for (const token of math.querySelectorAll('[data-paper-space]')) {
		const index = Number(token.textContent.match(/^PCSPACE(\d+)END$/)[1]);
		const space = element('mspace');
		space.setAttribute('width', spaces[index].width);
		token.replaceWith(space);
	}
	return { math, latex };
}

export function mathInventory(document) {
	return Array.from(document.querySelectorAll('mjx-container')).filter(el => !el.closest(excluded)).map((element, index) => {
		const id = element.closest('.display-formula')?.id || `mathjax-${index + 1}`;
		try {
			let sourceMath = element.querySelector('math');
			const savedMath = element.getAttribute('data-paper-mathml');
			if (savedMath) {
				if (savedMath.length > 200000) fail('MathML source exceeds snapshot limit');
				const template = document.createElement('template');
				template.innerHTML = savedMath;
				const root = template.content.firstElementChild;
				const allowed = new Set(['math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'ms', 'mspace', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mfrac', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'mfenced', 'mstyle', 'mpadded', 'mphantom', 'menclose', 'mmultiscripts', 'mprescripts', 'none']);
				if (!root || name(root) !== 'math' || template.content.children.length !== 1 ||
					[root, ...root.querySelectorAll('*')].some(node => !allowed.has(name(node)) ||
						Array.from(node.attributes).some(attr => /^on|href|src/i.test(attr.name)))) fail('Invalid captured MathML source');
				sourceMath = root;
			}
			const annotation = sourceMath?.querySelector('annotation[encoding="application/x-tex"]') || element.querySelector('annotation[encoding="application/x-tex"]');
			const sibling = element.nextElementSibling;
			const script = sibling?.matches('script[type="math/tex"], script[type="math/tex; mode=display"]') ? sibling : null;
			const explicit = element.getAttribute('data-latex') || element.getAttribute('data-tex') ||
				sourceMath?.getAttribute('data-latex') || sourceMath?.getAttribute('alttext') || annotation?.textContent || script?.textContent;
			let math, latex;
			if (explicit?.trim()) {
				latex = explicit.trim();
				math = sourceMath?.cloneNode(true) || document.createElement('math');
				if (!math.textContent) math.textContent = latex;
			} else if (sourceMath) {
				math = sourceMath.cloneNode(true);
				latex = toLatex(math.outerHTML);
			} else {
				const roots = children(element).filter(el => name(el) === 'mjx-math');
				if (roots.length !== 1) fail('No recoverable MathML, TeX or supported CHTML tree');
				({ math, latex } = reconstruct(roots[0]));
			}
			if (!latex?.trim()) fail('Empty formula conversion');
			const block = element.getAttribute('display') === 'true' || sourceMath?.getAttribute('display') === 'block' ||
				script?.getAttribute('type') === 'math/tex; mode=display' || !!element.closest('.display-formula, .MathJax_Display');
			// Defuddle represents an unfenced display MathML table as an aligned
			// equation. Normalize the source the same way, retaining every cell,
			// row and token; fenced matrices and nested environments stay intact.
			const rows = block && latex.match(/^\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}$/);
			if (rows && !/\\begin\{/.test(rows[1])) latex = `\\begin{aligned}\n${rows[1].trim()}\n\\end{aligned}`;
			return { element, id, math, latex, block, script };
		} catch (error) { return { element, id, error: error.message }; }
	});
}

// Call on the snapshot copy before generic script/style cleanup. CHTML spacing
// and sibling TeX scripts are formula data, not merely page presentation.
export function retainMathForSnapshot(document) {
	for (const item of mathInventory(document)) {
		if (item.error) continue;
		item.element.setAttribute('data-latex', item.latex);
		item.element.setAttribute('display', String(item.block));
	}
}

export function prepareMath(document) {
	const inventory = mathInventory(document);
	const unsupported = inventory.filter(item => item.error);
	if (unsupported.length) throw Object.assign(new Error(`Paper Clipper: ${unsupported.length} formula(s) could not be safely converted. Keep/export the source HTML for review.`), {
		code: 'formula-preservation', formulaPreservation: checkMathPreservation(document, '')
	});
	for (const { element, math, latex, block, script } of inventory) {
		math.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
		math.setAttribute('data-latex', latex);
		math.setAttribute('display', block ? 'block' : 'inline');
		math.removeAttribute('aria-hidden');
		math.removeAttribute('hidden');
		if (element.id) math.id = element.id;
		element.replaceWith(math);
		script?.remove();
	}
	// Figure reconstruction otherwise flattens rich caption math into plain
	// text. Preserve only affected captions beside their figure on this copy.
	for (const caption of Array.from(document.querySelectorAll('figure figcaption'))) {
		if (!caption.querySelector('math[data-latex]')) continue;
		const content = document.createElement('div');
		content.setAttribute('data-defuddle', 'true');
		content.append(...Array.from(caption.childNodes));
		caption.closest('figure').after(content);
		caption.remove();
	}
	// PMC uses a one-row table solely to align an equation and its number.
	// A Markdown table escapes TeX norm bars and breaks multi-line equations.
	// Unwrap only this exact layout; genuine data tables remain unchanged.
	for (const table of Array.from(document.querySelectorAll('table.disp-formula'))) {
		const cells = Array.from(table.querySelectorAll('td'));
		if (table.querySelectorAll('tr').length !== 1 || table.querySelector('th, table') || cells.length !== 2 ||
			!cells[0].matches('.formula') || !cells[1].matches('.label') || !/^\(\d+[a-z]?\)$/.test(cells[1].textContent.trim()) ||
			cells[0].children.length !== 1 || !cells[0].firstElementChild.matches('math[display="block"]') ||
			Array.from(cells[0].childNodes).some(node => node.nodeType === 3 && node.textContent.trim())) continue;
		const wrapper = document.createElement('div');
		if (table.id) wrapper.id = table.id;
		const label = document.createElement('p');
		label.textContent = cells[1].textContent.trim();
		wrapper.append(cells[0].firstElementChild, label);
		table.replaceWith(wrapper);
	}
}

function markdownMath(markdown) {
	const body = markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
	const spans = [];
	function visit(node) {
		if (['code', 'inlineCode', 'html', 'image', 'definition'].includes(node.type)) {
			spans.push([node.position.start.offset, node.position.end.offset]);
		} else for (const child of node.children || []) visit(child);
	}
	visit(fromMarkdown(body));
	let text = body;
	for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
	const formulas = [];
	const pattern = /(?<!\\)\$\$([\s\S]*?)(?<!\\)\$\$|(?<!\\)\$(?![\s$])((?:\\[^\n]|[^\\$\n])+?)(?<![\s\\])\$(?!\$)/g;
	for (const match of text.matchAll(pattern)) {
		formulas.push({ latex: match[1] ?? match[2], block: match[1] !== undefined });
	}
	return formulas;
}

function canonical(latex) {
	const tokens = [], textScopes = [];
	let textCommand = false;
	for (const token of latex.match(/\\[a-zA-Z]+|\\[\s\S]|[{}]|\s+|[^\\{}\s]/g) || []) {
		if (/^\s+$/.test(token)) {
			if (textScopes.at(-1)) tokens.push(' ');
			continue;
		}
		if (token === '{') textScopes.push(textCommand || !!textScopes.at(-1));
		else if (token === '}') textScopes.pop();
		textCommand = /^\\(?:text|textrm|textnormal|textbf|textit|operatorname)$/.test(token);
		tokens.push(token);
	}
	return JSON.stringify(tokens);
}

export function checkMathPreservation(document, markdown) {
	const inventory = mathInventory(document);
	const formulas = inventory.length ? markdownMath(markdown) : [];
	const missing = [], unsupported = [];
	for (const item of inventory) {
		if (item.error) { unsupported.push({ id: item.id, reason: item.error }); continue; }
		const index = formulas.findIndex(formula => formula.block === item.block && canonical(formula.latex) === canonical(item.latex));
		if (index < 0) missing.push(item.id);
		else formulas.splice(index, 1);
	}
	return { status: missing.length || unsupported.length ? 'failed' : inventory.length ? 'passed' : 'not-applicable',
		scope: 'mathjax-source-v1', expected: inventory.length, matched: inventory.length - missing.length - unsupported.length,
		missing, unsupported };
}

export function assertMathPreserved(document, markdown) {
	const report = checkMathPreservation(document, markdown);
	if (report.status === 'failed') throw Object.assign(new Error(`Paper Clipper: formula preservation failed (${report.matched}/${report.expected} matched). Keep/export the source HTML for review.`), { code: 'formula-preservation', formulaPreservation: report });
}
