// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import Defuddle from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';
import { strFromU8, unzipSync } from 'fflate';
import { prepareDocumentForExtraction } from './publisher-figures';
import { checkManualExport, ManualExportSnapshot, prepareManualExportChecks } from './manual-export-checks';
import { markdownSha256 } from './manual-export-report';
import { createImageArchive, prepareImageFiles } from './image-archive';

const cell = 'https://www.cell.com/cell/fulltext/synthetic-checks';
const nature = 'https://www.nature.com/articles/synthetic-checks';
const body = '<h1>Synthetic checks paper</h1><h2>Introduction</h2><p>' + 'Scientific observations and measurements. '.repeat(100) + '</p>';
const cellContent = `<div role="paragraph">This synthetic study compares tissue neighborhoods and reports experimental observations. Finding.<span class="dropBlock reference-citations"><a id="body-ref-1" href="#" class="reference-citations__ctrl" data-xml-rid="bib3" aria-controls="ref-1"><sup>1</sup></a><div id="ref-1" class="dropBlock__holder"><div class="citation-content">Preview only.</div></div></span> Second finding.<span class="reference-citations"><a href="#" class="reference-citations__ctrl" data-xml-rid="bib7" aria-controls="ref-2"><sup>2</sup></a><div id="ref-2" class="dropBlock__holder"><div class="citation-content">Second preview.</div></div></span> These observations describe the measurements in the experimental study.</div>
<figure class="graphic"><img src="https://images.example.org/main.png"><figcaption><div class="figure__title">Figure 1. Synthetic caption</div><div class="accordion" hidden><div class="figure__caption__text__content"><div role="paragraph">(A) Complete caption with <a href="https://example.org/method">method</a>.</div><div role="paragraph">(B) Second panel.</div></div></div></figcaption></figure>
<p>Variable <mjx-container data-latex="x_1"><math><mi>x</mi></math></mjx-container> is measured.</p>
<section id="references"><h2>References</h2><div role="doc-bibliography"><div class="bibliolist"><div class="biblioentry"><div class="citations" id="bib3"><div class="citation"><div class="citation-content"><div class="label"><a href="#body-ref-1">1.</a></div><div>A. Author.</div><div><strong>Full reference title.</strong></div><div>Synthetic journal. 2026.</div></div><div class="external-links"><a href="https://example.org/reference">Source</a></div></div></div></div><div class="biblioentry"><div class="citations" id="bib7"><div class="citation-content"><div class="label">2.</div><div>B. Author.</div><div>Another reference. Synthetic journal. 2025.</div></div></div></div></div></div></section>`;
const extendedImage = 'https://media.springernature.com/lw685/springer-static/esm/art%3A10.1234%2Ftest/MediaObjects/Fig6.jpg';
const natureContent = `<figure><img src="https://images.example.org/main.png"><figcaption>Fig. 1: Main figure.</figcaption><div class="c-article-section__figure-description"><p>A synthetic main caption.</p></div></figure>
<section><h2>Extended data figures and tables</h2><div class="c-article-supplementary__item"><h3><a href="/articles/synthetic-checks/figures/6" data-supp-info-image="${extendedImage}">Extended Data Fig. 1 Synthetic extension.</a></h3><p>Extended caption.</p></div></section>`;
function snapshot(content = cellContent, source = cell): ManualExportSnapshot {
	const document = new DOMParser().parseFromString(`<html><head><title>Synthetic checks paper</title></head><body><article>${body}${content}</article></body></html>`, 'text/html');
	const extractedMarkdown = createMarkdownContent(new Defuddle(prepareDocumentForExtraction(document, source), { url: source }).parse().content, source);
	return { document, source, extractedMarkdown, templateMarkdown: extractedMarkdown };
}
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe('manual export preservation reports', () => {
	it('checks actual converted collapsed Cell captions, complete references and formulas, without mutating the source', () => {
		const capture = snapshot();
		const before = capture.document.documentElement.outerHTML;
		const report = checkManualExport(capture, capture.templateMarkdown);
		expect(report.preservation).toBe('passed-within-scope');
		expect(report.completeness).toBe('not-assessed');
		expect(report.coverage).toBe('partial-source');
		expect(report.changes).toEqual({ template: 'unchanged', editor: 'unchanged' });
		for (const name of ['captions', 'references', 'math'] as const) expect(report.stages.output[name]).toMatchObject({ status: 'passed', expected: name === 'references' ? 2 : 1, matched: name === 'references' ? 2 : 1 });
		expect(report.stages.output.extendedImages.status).toBe('not-covered');
		expect(capture.document.documentElement.outerHTML).toBe(before);
	});
	it.each([
		['captions', (md: string) => md.replace('(B) Second panel.', '')],
		['captions', (md: string) => md.replace('[method](https://example.org/method)', 'method')],
		['references', (md: string) => md.replace(/Full reference title\./g, '')],
		['references', (md: string) => md.replace('[Source](https://example.org/reference)', 'Source')],
		['references', (md: string) => md.replace('Finding.[^1]', 'Finding.')],
		['references', (md: string) => md + '\n\n' + md.split('\n').find(line => line.startsWith('[^1]:'))],
		['math', (md: string) => md.replace('$x_1$', '')],
	] as const)('keeps editor differences separate from successful extraction: %s', (name, edit) => {
		const capture = snapshot();
		const report = checkManualExport(capture, edit(capture.templateMarkdown));
		expect(report.changes.editor).toBe('changed');
		expect(report.stages.extraction[name].status).toBe('passed');
		expect(report.stages.template[name].status).toBe('passed');
		expect(report.stages.output[name].status).toBe('failed');
		expect(report.preservation).toBe('attention-required');
	});
	it('identifies a conversion loss even when a template later supplies the missing text', () => {
		const capture = snapshot();
		capture.extractedMarkdown = capture.extractedMarkdown.replace('(B) Second panel.', '');
		const report = checkManualExport(capture, capture.templateMarkdown);
		expect(report.stages.extraction.captions.status).toBe('failed');
		expect(report.stages.output.captions.status).toBe('passed');
		expect(report.preservation).toBe('attention-required');
	});
	it('labels selection/custom-template losses separately without attributing intent', () => {
		const capture = snapshot();
		capture.templateMarkdown = '# Selected excerpt\n\nFinding.';
		const report = checkManualExport(capture, capture.templateMarkdown);
		expect(report.changes).toEqual({ template: 'changed', editor: 'unchanged' });
		expect(report.stages.extraction.captions.status).toBe('passed');
		expect(report.stages.template.captions.status).toBe('failed');
	});
	it('requires Nature extended images after their headings, not just a figure-viewer link', () => {
		const capture = snapshot(natureContent, nature);
		const report = checkManualExport(capture, capture.templateMarkdown);
		expect(report.stages.output.extendedImages).toMatchObject({ status: 'passed', expected: 1, matched: 1 });
		expect(report.stages.output.captions.status).toBe('passed');
		const withoutImage = capture.templateMarkdown.replace(/!\[Extended Data[^\n]+/g, '');
		expect(checkManualExport(capture, withoutImage).stages.output.extendedImages.status).toBe('failed');
		const referenceStyle = capture.templateMarkdown.replace(/!\[Extended Data[^\n]+/g, '![Extension][extended]') + `\n\n[extended]: ${extendedImage}`;
		expect(checkManualExport(capture, referenceStyle).stages.output.extendedImages.status).toBe('passed');
		const wrongImage = capture.templateMarkdown.replace(/!\[Extended Data[^\n]+/g, `[Image](${extendedImage}) ![Other][other]`) + '\n\n[other]: https://example.org/wrong.png';
		expect(checkManualExport(capture, wrongImage).stages.output.extendedImages.status).toBe('failed');
	});
	it('does not mistake images, code blocks, or unindented prose for a complete reference', () => {
		const capture = snapshot();
		const definition = capture.templateMarkdown.split('\n').find(line => line.startsWith('[^1]:'))!;
		for (const replacement of ['[^1]: 1.\n\n' + definition.slice(6), '```md\n' + definition + '\n```', '![A. Author. Full reference title. Synthetic journal. 2026.Source](https://example.org/reference)']) {
			expect(checkManualExport(capture, capture.templateMarkdown.replace(definition, replacement)).stages.output.references.status).toBe('failed');
		}
	});
	it('reports unavailable source image addresses as uncovered, not proven extraction loss', () => {
		const capture = snapshot(natureContent.replace(` data-supp-info-image="${extendedImage}"`, ''), nature);
		const report = checkManualExport(capture, capture.templateMarkdown);
		expect(report.stages.output.extendedImages.status).toBe('not-covered');
		expect(report.stages.output.extendedImages.issues[0].reason).toBe('source-image-address-unavailable');
	});
	it('never treats unavailable sources or unknown publishers as verified complete', () => {
		for (const capture of [undefined, snapshot('<p>No known structures.</p>', 'https://unknown.example.org/article')]) {
			const report = checkManualExport(capture, capture?.templateMarkdown ?? 'Manual note');
			expect(report).toMatchObject({ completeness: 'not-assessed', preservation: 'not-assessed', coverage: 'not-assessed' });
			expect(Object.values(report.stages.output).every(check => check.status === 'not-covered')).toBe(true);
		}
	});
	it('writes the same compact bound report to ZIP and file preparation, hashing the actual localized note', async () => {
		const capture = snapshot(natureContent, nature);
		const markdown = '---\ncustom: preserved\n---\n' + capture.templateMarkdown;
		const context = await prepareManualExportChecks(capture, markdown);
		vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]), { headers: { 'Content-Type': 'image/png' } })));
		const prepared = await prepareImageFiles(markdown, nature, undefined, {}, structuredClone(context));
		const zip = unzipSync((await createImageArchive(markdown, 'Synthetic', nature, undefined, {}, context)).bytes);
		const report = JSON.parse(strFromU8(prepared.files['checks.json']));
		expect(strFromU8(zip[Object.keys(zip).find(key => key.endsWith('/checks.json'))!])).toBe(strFromU8(prepared.files['checks.json']));
		expect(report.artifact.value).toBe(await markdownSha256(strFromU8(prepared.files['paper.md'])));
		expect(report.images).toMatchObject({ status: 'passed', downloaded: 2 });
		expect(report.stages.output.extendedImages.status).toBe('passed');
		expect(JSON.stringify(report)).not.toContain('https://');
		expect(JSON.stringify(report)).not.toContain('Synthetic extension');
		const mismatched = await prepareImageFiles('Different note', nature, undefined, {}, context);
		expect(mismatched.checks.preservation).toBe('not-assessed');
	});
});
