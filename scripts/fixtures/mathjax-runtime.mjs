// Synthetic examples of MathJax's retained input and lazy rendering. No paper text.
// A publisher may attach this same accessibility placeholder to every formula.
// It must never replace the structural MathML, including after MAIN-world capture.
const mml = (body, display = false) => `<mjx-container display="${display}" data-paper-mathml="${(`<math alttext="No alternative text available" display="${display ? 'block' : 'inline'}">${body}</math>`).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"><mjx-lazy></mjx-lazy></mjx-container>`;
const norm = '<mo>∥</mo><mi>x</mi><mo>∥</mo>';
const variable = '<msub><mi mathvariant="bold">Q</mi><mrow><mtext>sample</mtext><mo>_</mo><mtext>ctrl</mtext></mrow></msub>';
const prose = 'This synthetic experiment documents independent observations and repeatable measurements of a mathematical model. '.repeat(35);
export const runtimeMathHtml = `<html><head><title>Synthetic lazy formulas</title></head><body><article><h1>Synthetic lazy formulas</h1>
<h2>Results</h2><p>${prose}</p><p>The observed score ${mml(variable)} is retained inline.</p>
<figure><img src="https://images.example.org/math-figure.png"><figcaption><p>Figure A. Repeated score ${mml(variable)} with <strong>bold caption text</strong> and a <a href="#methods">method link</a>.</p></figcaption></figure>
<h2 id="methods">Methods</h2><p>${prose}</p><p>A numbered norm is evaluated below.</p>
<table class="disp-formula p" id="E1"><tr><td class="formula">${mml(norm, true)}</td><td class="label">(1)</td></tr></table>
<p>The aligned system is evaluated below.</p><table class="disp-formula p" id="E2"><tr><td class="formula">${mml('<mtable><mtr><mtd columnalign="left"><mi>x</mi><mo>=</mo><mn>1</mn></mtd></mtr><mtr><mtd columnalign="left"><mi>y</mi><mo>=</mo><mn>2</mn></mtd></mtr></mtable>', true)}</td><td class="label">(2)</td></tr></table>
<p>TeX input <mjx-container data-latex="z_{k}"><mjx-lazy></mjx-lazy></mjx-container> remains inline.</p></article></body></html>`;

// Execute in the synthetic page's MAIN world. Emulates the documented runtime
// association without loading remote scripts or publishing source data in DOM.
export function installSyntheticMathJax() {
	window.MathJax = { startup: { document: { math: Array.from(document.querySelectorAll('mjx-container')).map(typesetRoot => {
		const mathml = typesetRoot.getAttribute('data-paper-mathml');
		const item = { typesetRoot, math: mathml || typesetRoot.getAttribute('data-latex'), inputJax: { name: mathml ? 'MathML' : 'TeX' }, display: typesetRoot.getAttribute('display') === 'true' };
		typesetRoot.removeAttribute('data-paper-mathml');
		typesetRoot.removeAttribute('data-latex');
		return item;
	}) } } };
}
