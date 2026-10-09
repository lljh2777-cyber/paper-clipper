import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { clipPaper, normalizeMathJaxTex, normalizeMathMLForReader, normalizePublisherLinks, parseOptions } from './clip-paper.mjs';
import { assessMarkdown, bodyCheckVersion } from './paper-validation.mjs';
import { parseHTML } from 'linkedom';
import { reviewHtml, reviewDoi, reviewUrl } from './fixtures/nature-review.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const paragraph = 'This research compares tissue expression and spatial organization across biological samples. '.repeat(80);
const article = `<h1>Spatial research fixture</h1><h2>Results</h2><p>${paragraph}</p><h2>Methods</h2><p>${paragraph}</p><p><a href="/figures/1">Figure 1</a></p>`;
const fullHtml = `<!doctype html><html><head><title>Spatial research fixture</title></head><body><article>${article}</article></body></html>`;
const previewHtml = '<html><head><title>Preview</title></head><body><article><h1>Preview</h1><p>This is a preview of subscription content</p></article></body></html>';
let server;
let baseUrl;
let directory;
let requests = 0;

before(async () => {
	const output = path.join(root, 'output/browser-fetch/tests');
	await mkdir(output, { recursive: true });
	directory = await mkdtemp(path.join(output, 'pipeline-'));
	server = createServer((request, response) => {
		requests++;
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		if (request.url === '/redirect') {
			response.writeHead(302, { Location: '/article' }).end();
		} else if (request.url === '/article') {
			response.end(fullHtml);
		} else if (request.url === '/canonical?session=transient') {
			response.end(fullHtml.replace('</head>', '<link rel="canonical" href="/canonical"></head>'));
		} else if (request.url === '/external-canonical') {
			response.end(fullHtml.replace('</head>', '<link rel="canonical" href="https://example.com/different"></head>'));
		} else if (request.url === '/dynamic') {
			response.end(`<html><head><title>Spatial research fixture</title></head><body><article>Loading</article>
				<script>setTimeout(() => { document.querySelector('article').innerHTML = ${JSON.stringify(article)}; }, 450);</script></body></html>`);
		} else if (request.url === '/json') {
			response.setHeader('Content-Type', 'application/json');
			response.end('{"error":"not HTML"}');
		} else if (request.url === '/failure') {
			response.writeHead(403).end('Forbidden');
		} else if (request.url === '/browser-only') {
			if (request.headers['user-agent']?.includes('Chrome/')) response.end(fullHtml);
			else response.writeHead(403).end('Browser fixture required');
		} else if (request.url === '/slow') {
			// Keep the request open until the client's timeout cancels it.
		} else {
			response.end(previewHtml);
		}
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	server.closeAllConnections();
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function options(name, route, extra = []) {
	return parseOptions([`${baseUrl}${route}`, '-o', path.join(directory, `${name}.md`),
		'--timeout', '10000', '--settle', '700', '--min-words', '100', ...extra]);
}

test('validates option combinations and selects explicit browser interaction without HTTP first', () => {
	assert.throws(() => parseOptions(['https://example.com']), /output/);
	assert.throws(() => options('bad', '/', ['--fetch', 'unknown']), /auto, http, or browser/);
	assert.throws(() => options('bad', '/', ['--fetch', 'http', '--login']), /Browser interaction/);
	assert.throws(() => options('bad', '/', ['--html', 'input.html', '--login']), /cannot be combined/);
	assert.throws(() => options('bad', '/', ['--min-words', 'NaN']), /positive integer/);
	assert.throws(() => options('bad', '/', ['--require-section', ' ']), /cannot be empty/);
	assert.equal(options('interactive', '/', ['--headed']).mode, 'browser');
});

test('basic checks reject long abstract/reference pages and require requested sections', () => {
	const result = assessMarkdown(`## Abstract\nShort abstract.\n## References\n${paragraph}`, { minWords: 100 });
	assert.deepEqual(result.reasons, ['too-short', 'missing-main-sections']);
	const missing = assessMarkdown(`## Results\n${paragraph}\n## Methods\n${paragraph}`, { minWords: 100, requiredSections: ['Discussion'] });
	assert.deepEqual(missing.reasons, ['missing-section:Discussion']);
});

test('normalizes only explicit unrendered MathJax wrappers, preserving raw data and code', () => {
	const html = String.raw`<!doctype html><html><body>
		<p>Formula <span class="mathjax-tex" id="eq-inline">\(x_i &lt; y_i\)</span>.</p>
		<div class="mathjax-tex">$$\frac{a_b}{c}$$</div><span class="mathjax-tex">\[x^2\]</span>
		<code><span class="mathjax-tex">\(example\)</span></code>
		<span class="mathjax-tex">$20</span><span class="mathjax-tex">\(\)</span>
		<span class="mathjax-tex">\(unclosed</span><p>Ordinary text \(not labelled\) and $50</p>
		<span class="mathjax-tex"><math data-latex="z">z</math></span>
		</body></html>`;
	const result = normalizeMathJaxTex(html);
	assert.equal(result.count, 3);
	const { document } = parseHTML(result.html);
	assert.equal(document.querySelector('#eq-inline math').getAttribute('data-latex'), 'x_i < y_i');
	assert.equal(document.querySelector('#eq-inline math').getAttribute('display'), 'inline');
	assert.equal(document.querySelectorAll('math[display="block"]').length, 2);
	assert.equal(document.querySelector('code .mathjax-tex').textContent, String.raw`\(example\)`);
	assert.ok(result.html.includes(String.raw`Ordinary text \(not labelled\) and $50`));
	assert.equal(normalizeMathJaxTex(result.html).count, 0);
	assert.equal(normalizeMathJaxTex(fullHtml).html, fullHtml);
});

test('funding-heavy empty sections fail the actual converter without replacing an accepted note', { timeout: 15000 }, async () => {
	const input = path.join(directory, 'empty-sections.html');
	const destination = path.join(directory, 'empty-sections.md');
	const html = `<html><head><title>Empty sections</title></head><body><article><h1>Empty sections</h1><h2>Main</h2><h2>Methods</h2><h2>Funding</h2><p>${paragraph}</p><p>${paragraph}</p></article></body></html>`;
	await writeFile(input, html);
	await writeFile(destination, 'Previous accepted note and annotations.');
	const before = (await stat(destination)).mtimeMs;
	const result = await clipPaper(parseOptions([baseUrl + '/unused', '--html', input, '-o', destination, '--overwrite']));
	assert.equal(result.exitCode, 2);
	assert.equal(result.report.outputWritten, false);
	assert.ok(result.report.attempts[0].quality.reasons.includes('too-short'));
	assert.equal(result.report.attempts[0].quality.bodyCheck, bodyCheckVersion);
	assert.equal(await readFile(destination, 'utf8'), 'Previous accepted note and annotations.');
	assert.equal((await stat(destination)).mtimeMs, before);
});

test('third-level article sections survive actual conversion and required-section validation', { timeout: 15000 }, async () => {
	const input = path.join(directory, 'third-level-sections.html');
	await writeFile(input, fullHtml.replaceAll('<h2>', '<h3>').replaceAll('</h2>', '</h3>'));
	const result = await clipPaper(parseOptions([baseUrl + '/unused', '--html', input,
		'-o', path.join(directory, 'third-level-sections.md'), '--require-section', 'Methods']));
	assert.equal(result.exitCode, 0);
	assert.ok(result.report.attempts[0].quality.mainBodyWords >= 1000);
	assert.equal(result.report.checks.bodyCheck, bodyCheckVersion);
});

test('offline publisher math survives the actual CLI with dollar delimiters and unescaped TeX', { timeout: 15000 }, async () => {
	const math = String.raw`<p>Inline <span class="mathjax-tex">\(x_i + \alpha\)</span> is preserved.</p>
		<div class="mathjax-tex">$$\frac{x_i}{y_j}$$</div>`;
	const html = fullHtml.replace('</article>', () => `${math}</article>`);
	const input = path.join(directory, 'math.html');
	await writeFile(input, html, 'utf8');
	const config = options('math', '/offline-math', ['--html', input]);
	const before = requests;
	const { exitCode, report } = await clipPaper(config);
	assert.equal(exitCode, 0);
	assert.equal(requests, before);
	assert.equal(report.attempts[0].normalizations.mathJaxTex, 2);
	assert.equal(await readFile(input, 'utf8'), html);
	assert.equal(await readFile(report.attempts[0].html, 'utf8'), html);
	const markdown = await readFile(config.output, 'utf8');
	assert.ok(markdown.includes(String.raw`$x_i + \alpha$`));
	assert.ok(markdown.includes('$$\n' + String.raw`\frac{x_i}{y_j}` + '\n$$'));
	assert.ok(!markdown.includes(String.raw`\\alpha`));
});

test('Nature section preservation checks extraction and final templates before publishing', { timeout: 15000 }, async () => {
	const section = (heading, body) => `<section data-title="${heading}"><div><h2 class="c-article-section__title">${heading}</h2><div class="c-article-section__content">${body}</div></div></section>`;
	const source = `<html><head><title>Section fixture</title></head><body><article class="c-article-body"><h1>Section fixture</h1><div class="main-content">${section('Main', `<p>Main study. ${paragraph}</p><p>Unique source sentence.</p>`)}${section('Methods', `<p>Methods study. ${paragraph}</p>`)}</div></article></body></html>`;
	const input = path.join(directory, 'nature-source-sections.html');
	await writeFile(input, source);
	const config = { ...options('nature-source-sections', '/unused', ['--html', input]), url: 'https://www.nature.com/articles/fixture' };
	const result = await clipPaper(config);
	assert.equal(result.exitCode, 0);
	assert.equal(result.report.attempts[0].quality.sourceSections.matchedParagraphs, 3);
	assert.equal(result.report.attempts[0].quality.outputSourceSections.status, 'passed');
	const previous = await readFile(config.output, 'utf8');
	const mtime = (await stat(config.output)).mtimeMs;
	const template = path.join(directory, 'nature-source-sections-template.json');
	await writeFile(template, JSON.stringify({ noteNameFormat: '{{title}}', noteContentFormat: 'Summary: {{title}}', properties: [] }));
	const rejected = await clipPaper({ ...config, template, overwrite: true, downloadAssets: true });
	assert.equal(rejected.exitCode, 2);
	assert.equal(rejected.report.outputWritten, false);
	assert.equal(rejected.report.attempts[0].quality.sourceSections.status, 'passed');
	assert.deepEqual(rejected.report.attempts[0].quality.reasons, ['output-source-sections', 'output-too-short', 'output-missing-main-sections']);
	assert.equal(rejected.report.assets, undefined);
	assert.equal(await readFile(config.output, 'utf8'), previous);
	assert.equal((await stat(config.output)).mtimeMs, mtime);
	await assert.rejects(stat(path.join(rejected.report.artifactDirectory, 'accepted.md')), { code: 'ENOENT' });
	await writeFile(template, JSON.stringify({ noteNameFormat: '{{title}}', noteContentFormat: '{{content}}', properties: [] }));
	assert.equal((await clipPaper({ ...config, output: path.join(directory, 'nature-source-sections-custom.md'), template })).exitCode, 0);
	// A source paragraph in an aside is intentionally removed by the reader.
	// Remaining prose still passes the size gate, but not source preservation.
	await writeFile(input, source.replace('<p>Unique source sentence.</p>', '<aside><p>Unique source sentence.</p></aside>'));
	const lost = await clipPaper({ ...config, overwrite: true });
	assert.equal(lost.exitCode, 2);
	assert.ok(lost.report.attempts[0].quality.mainBodyWords > 1000);
	assert.ok(lost.report.attempts[0].quality.reasons.includes('source-sections'));
	assert.equal(await readFile(config.output, 'utf8'), previous);
	assert.equal(await readFile(lost.report.attempts[0].html, 'utf8'), await readFile(input, 'utf8'));
});

test('publisher reference normalization is scoped, preserves labels and is idempotent', () => {
	const html = '<html><body><p>[<a class="ref-tip" href="#paper.ref001">1</a>]</p><a class="ref-tip" href="https://example.com">Other</a><code><a class="ref-tip" href="#example">2</a></code></body></html>';
	const result = normalizePublisherLinks(html, 'https://journals.plos.org/article?id=paper');
	assert.equal(result.count, 1);
	assert.match(result.html, /href="https:\/\/journals.plos.org\/article\?id=paper#paper.ref001"/);
	assert.equal(normalizePublisherLinks(result.html, 'https://journals.plos.org/article?id=paper').count, 0);
	assert.equal(normalizePublisherLinks(html, 'https://example.com').html, html);
	assert.equal(normalizePublisherLinks(html, 'https://frontiersin.org.example.com').html, html);
});

test('Nature legends outside figcaption survive the actual CLI in order with links and formatting', async () => {
	const figure = '<figure><figcaption>Fig. 1: Overview.</figcaption><div><img src="/figure.png" alt="Fig. 1: Overview." width="685" height="395"><div class="c-article-section__figure-description"><p><b>a</b>, Detailed caption with <a href="https://example.com/data">data link</a>.</p><p><b>b</b>, Repeated <i>x</i> and <i>x</i> matter.</p></div></div></figure><p>After figure marker.</p>';
	const html = fullHtml.replace('</article>', `${figure}</article>`);
	const input = path.join(directory, 'nature-legends.html');
	await writeFile(input, html);
	const config = { ...options('nature-legends', '/unused', ['--html', input]), url: 'https://www.nature.com/articles/fixture' };
	const result = await clipPaper(config);
	assert.equal(result.exitCode, 0);
	assert.equal(await readFile(result.report.attempts[0].html, 'utf8'), html);
	assert.equal(result.report.attempts[0].quality.figureCaptions.status, 'passed');
	assert.equal(result.report.attempts[0].quality.figureCaptions.matched, 1);
	assert.equal(result.report.attempts[0].quality.outputFigureCaptions.status, 'passed');
	const markdown = await readFile(config.output, 'utf8');
	assert.ok(markdown.includes('**a**, Detailed caption with [data link](https://example.com/data).'));
	assert.ok(markdown.includes('**b**, Repeated *x* and *x* matter.'));
	assert.equal(markdown.split('Detailed caption').length, 2);
	assert.ok(markdown.indexOf('Detailed caption') > markdown.indexOf('Fig. 1: Overview.'));
	assert.ok(markdown.indexOf('Detailed caption') < markdown.indexOf('After figure marker.'));
});

test('single-section review and grouped caption citations pass the actual CLI and full-content templates', async () => {
	const figure = '<figure><figcaption>Fig. 1: Synthetic model.</figcaption><img src="/figure.png" width="685" height="395"><div class="c-article-section__figure-description"><p>Model details cite sources <sup><a href="#ref-CR1">1</a>,<a href="#ref-CR2">2</a></sup>.</p></div></figure>';
	const source = reviewHtml.replace('</article>', `${figure}<h2>References</h2><ol><li id="ref-CR1">First synthetic source.</li><li id="ref-CR2">Second synthetic source.</li></ol></article>`);
	const input = path.join(directory, 'review.html'), template = path.join(directory, 'review-template.json');
	await writeFile(input, source);
	await writeFile(template, JSON.stringify({ noteNameFormat: '{{title}}', noteContentFormat: '# {{title}}\n\n{{content}}', properties: [] }));
	const config = { ...options('review', '/unused', ['--html', input, '--min-words', '1000']), url: reviewUrl, expectedDoi: reviewDoi };
	for (const [name, extra] of [['review', {}], ['review-custom', { template }]]) {
		const result = await clipPaper({ ...config, output: path.join(directory, name + '.md'), ...extra });
		assert.equal(result.exitCode, 0);
		const quality = result.report.attempts[0].quality;
		assert.equal(quality.sectionRule, 'nature-review-source-v1');
		assert.equal(quality.outputQuality.sectionRule, 'nature-review-source-v1');
		assert.equal(quality.figureCaptions.status, 'passed');
		assert.equal(quality.outputFigureCaptions.status, 'passed');
		assert.match(await readFile(result.report.output, 'utf8'), /\[\^1\],\[\^2\]/);
		assert.equal(await readFile(result.report.attempts[0].html, 'utf8'), source);
	}
	await writeFile(template, JSON.stringify({ noteNameFormat: '{{title}}', noteContentFormat: '# {{title}}', properties: [] }));
	const rejected = await clipPaper({ ...config, output: path.join(directory, 'review-rejected.md'), template });
	assert.equal(rejected.exitCode, 2);
	assert.equal(rejected.report.outputWritten, false);
	assert.ok(rejected.report.attempts[0].quality.reasons.includes('output-source-sections'));
});

test('lost source legends fail real conversion before publishing or replacing an accepted paper', async () => {
	const html = fullHtml.replace('</article>', '<figure><figcaption>Fig. 1: Missing panel.</figcaption><img src="/figure.png" width="685" height="395"><div class="c-article-section__figure-description" id="figure-1-desc"><p hidden>Source legend hidden from extraction.</p></div></figure></article>');
	const input = path.join(directory, 'nature-missing-caption.html');
	await writeFile(input, html);
	const config = { ...options('nature-missing-caption', '/unused', ['--html', input, '--overwrite']), url: 'https://www.nature.com/articles/fixture' };
	await writeFile(config.output, 'Previously accepted paper');
	const result = await clipPaper(config);
	assert.equal(result.exitCode, 2);
	assert.equal(result.report.status, 'incomplete');
	assert.equal(result.report.outputWritten, false);
	assert.ok(result.report.attempts[0].quality.reasons.includes('figure-captions'));
	assert.equal(result.report.attempts[0].quality.figureCaptions.figures[0].title, 'Fig. 1: Missing panel.');
	assert.equal(await readFile(config.output, 'utf8'), 'Previously accepted paper');
	assert.equal(await readFile(result.report.attempts[0].html, 'utf8'), html);
	await assert.rejects(stat(path.join(result.report.artifactDirectory, 'accepted.md')), { code: 'ENOENT' });
});

test('a custom template cannot publish a title-only Nature note despite complete extraction', async () => {
	const html = fullHtml.replace('</article>', '<figure><figcaption>Fig. 1: Overview.</figcaption><img src="/figure.png" width="685" height="395"><div class="c-article-section__figure-description"><p>Full panel details retained in extraction.</p></div></figure></article>');
	const input = path.join(directory, 'nature-template-caption.html');
	const template = path.join(directory, 'nature-template.json');
	await writeFile(input, html);
	await writeFile(template, JSON.stringify({ noteNameFormat: '{{title}}', noteContentFormat: 'Summary: {{title}}', properties: [] }));
	const config = { ...options('nature-template-caption', '/unused', ['--html', input, '-t', template, '--download-assets']), url: 'https://www.nature.com/articles/fixture' };
	const result = await clipPaper(config);
	assert.equal(result.exitCode, 2);
	const attempt = result.report.attempts[0];
	assert.equal(attempt.quality.figureCaptions.status, 'passed');
	assert.equal(attempt.quality.outputFigureCaptions.status, 'failed');
	assert.deepEqual(attempt.quality.reasons, ['output-figure-captions', 'output-too-short', 'output-missing-main-sections']);
	assert.match(await readFile(attempt.renderedMarkdown, 'utf8'), /Summary:/);
	assert.equal(result.report.assets, undefined);
	await assert.rejects(stat(config.output), { code: 'ENOENT' });
});

test('MathML centered ellipses use supported TeX without changing raw math, code or explicit TeX', () => {
	const expression = '<math id="dots"><mi>x</mi><mo>&#x22EF;</mo><msub><mi>x</mi><mi>n</mi></msub></math>';
	const html = `<html><body>${expression}<code>${expression.replace('dots', 'code')}</code>
		<math id="tex" data-latex="custom"><mo>&#x22ef;</mo></math>
		<math id="alt" alttext="custom"><mo>&#x22ef;</mo></math>
		<math id="annotation"><semantics><mo>&#x22ef;</mo><annotation encoding="application/x-tex">custom</annotation></semantics></math>
		<math id="mixed"><mo>&#x22ef;</mo><mo>&#x2026;</mo></math>
		<math id="lower"><mo>&#x2026;</mo></math><p>Literal \\hdots stays here.</p></body></html>`;
	const result = normalizeMathMLForReader(html);
	const { document } = parseHTML(result.html);
	assert.equal(result.count, 1);
	assert.equal(document.querySelector('#dots').getAttribute('data-latex'), String.raw`x \cdots x_{n}`);
	assert.equal(document.querySelector('#dots mo').textContent, '\u22ef');
	for (const id of ['code', 'alt', 'annotation', 'mixed', 'lower']) assert.equal(document.querySelector(`#${id}`).hasAttribute('data-latex'), false);
	assert.equal(document.querySelector('#tex').getAttribute('data-latex'), 'custom');
	assert.ok(result.html.includes(String.raw`Literal \hdots stays here.`));
	assert.equal(normalizeMathMLForReader(result.html).count, 0);
	assert.equal(normalizeMathMLForReader(fullHtml).html, fullHtml);
});

test('MathML ellipsis repair survives the CLI in inline and display equations, including custom templates', { timeout: 15000 }, async () => {
	const math = '<math><mrow><mi>X</mi><mo>=</mo><mi>x</mi><mo>&#x22ef;</mo><msub><mi>x</mi><mi>n</mi></msub></mrow></math>';
	const html = fullHtml.replace('</article>', `<p>Inline ${math} remains.</p><div>${math.replace('<math>', '<math display="block">')}</div></article>`);
	const input = path.join(directory, 'mathml-dots.html');
	await writeFile(input, html);
	for (const template of [undefined, path.join(directory, 'mathml-template.json')]) {
		if (template) await writeFile(template, JSON.stringify({ name: 'Math test', noteNameFormat: 'Math test', noteContentFormat: '{{content}}', properties: [] }));
		const config = options(template ? 'mathml-custom' : 'mathml-default', '/mathml', ['--html', input, ...(template ? ['--template', template] : [])]);
		const result = await clipPaper(config);
		assert.equal(result.exitCode, 0);
		assert.equal(result.report.attempts[0].normalizations.mathMLEllipses, 2);
		assert.equal(await readFile(result.report.attempts[0].html, 'utf8'), html);
		const markdown = await readFile(config.output, 'utf8');
		assert.equal((markdown.match(/\\cdots\b/g) ?? []).length, 2);
		assert.ok(markdown.includes(String.raw`$X = x \cdots x_{n}$`));
		assert.ok(markdown.includes('$$\n' + String.raw`X = x \cdots x_{n}` + '\n$$'));
		assert.ok(!markdown.includes('\\hdots'));
	}
});

test('nested MathML case tables retain their structure through HTML cleanup and the CLI', async () => {
	const math = '<math><mi>f</mi><mo>=</mo><mrow><mo>{</mo><mtable><mtr><mtd><mtable><mtr><mtd><msub><mi>x</mi><mi>i</mi></msub></mtd><mtd><mi>x</mi><mo>&gt;</mo><mn>0</mn></mtd></mtr></mtable></mtd></mtr><mtr><mtd><mtable><mtr><mtd><mn>0</mn></mtd><mtd><mi>x</mi><mo>&#x2264;</mo><mn>0</mn></mtd></mtr></mtable></mtd></mtr></mtable></mrow></math>';
	const html = fullHtml.replace('</article>', `<p>Cases: ${math}</p></article>`);
	const normalized = normalizeMathMLForReader(html);
	assert.equal(normalized.nestedTables, 1);
	assert.equal(normalized.ellipses, 0);
	assert.equal(normalizeMathMLForReader(normalized.html).count, 0);
	assert.equal(parseHTML(normalized.html).document.querySelectorAll('mtable').length, 3);
	const input = path.join(directory, 'mathml-cases.html');
	await writeFile(input, html);
	const config = options('mathml-cases', '/unused', ['--html', input]);
	const result = await clipPaper(config);
	assert.equal(result.exitCode, 0);
	assert.equal(result.report.attempts[0].normalizations.mathMLTables, 1);
	assert.equal(await readFile(result.report.attempts[0].html, 'utf8'), html);
	const markdown = await readFile(config.output, 'utf8');
	assert.match(markdown, /\\begin\{cases\}/);
	assert.match(markdown, /x_\{i\}/);
	assert.match(markdown, /\\leq 0/);
	assert.match(markdown, /\\end\{cases\}/);
});

test('PLOS numeric and Frontiers equation/citation links survive the actual CLI', { timeout: 15000 }, async () => {
	for (const [name, url, className, label, target] of [
		['plos', 'https://journals.plos.org/article?id=paper', 'ref-tip', '1', 'paper.ref001'],
		['frontiers', 'https://www.frontiersin.org/articles/paper/full', 'ArticleReference', 'Eq. 1', 'e1'],
	]) {
		const html = fullHtml.replace('</article>', `<p>Important citation [<a class="${className}" href="#${target}">${label}</a>].</p><div id="${target}">Reference target.</div></article>`);
		const input = path.join(directory, `${name}-refs.html`);
		await writeFile(input, html);
		const config = { ...options(`${name}-refs`, '/unused', ['--html', input]), url };
		const result = await clipPaper(config);
		assert.equal(result.exitCode, 0);
		assert.equal(result.report.attempts[0].normalizations.publisherLinks, 1);
		const markdown = await readFile(config.output, 'utf8');
		assert.ok(markdown.includes(`[${label}](${url}#${target})`));
		assert.equal(await readFile(input, 'utf8'), html);
	}
});

test('Frontiers missing equation targets and client challenges cannot pass long-body checks', { timeout: 15000 }, async () => {
	for (const [name, html, reason] of [
		['missing-math', fullHtml.replace('</article>', '<p>See <a class="ArticleReference" href="#e1">Eq. 1</a><span></span>.</p></article>'), 'unrendered-equations'],
		['client-challenge', fullHtml.replace('<title>Spatial research fixture</title>', '<title>Client Challenge</title>'), 'access-challenge'],
	]) {
		const input = path.join(directory, `${name}.html`);
		await writeFile(input, html);
		const config = { ...options(name, '/unused', ['--html', input]), url: 'https://www.frontiersin.org/articles/paper/full' };
		const result = await clipPaper(config);
		assert.equal(result.exitCode, 2);
		assert.ok(result.report.attempts[0].quality.reasons.includes(reason));
		await assert.rejects(stat(config.output), { code: 'ENOENT' });
	}
});

test('Frontiers figure-button captions survive without retaining ordinary controls', { timeout: 15000 }, async () => {
	const html = fullHtml.replace('</article>', '<div class="ArticleFigure"><button>Download figure</button><button class="ArticleFigure__figureButton"><figure><img src="https://example.com/figure.png"><figcaption>Complete figure caption with scientific details.</figcaption></figure></button></div></article>');
	const input = path.join(directory, 'figure-button.html');
	await writeFile(input, html);
	const config = { ...options('figure-button', '/unused', ['--html', input]), url: 'https://www.frontiersin.org/articles/paper/full' };
	const result = await clipPaper(config);
	assert.equal(result.exitCode, 0);
	assert.equal(result.report.attempts[0].normalizations.publisherFigures, 1);
	const markdown = await readFile(config.output, 'utf8');
	assert.match(markdown, /Complete figure caption with scientific details/);
	assert.ok(!markdown.includes('Download figure'));
	assert.equal(await readFile(input, 'utf8'), html);
});

test('HTTP success follows redirects, resolves links, and writes a report with no browser attempt', { timeout: 20000 }, async () => {
	const config = options('http', '/redirect');
	const { exitCode, report } = await clipPaper(config);
	assert.equal(exitCode, 0);
	assert.equal(report.status, 'passed-checks');
	assert.equal(report.url, `${baseUrl}/article`);
	assert.equal(report.attempts.length, 1);
	assert.equal(report.attempts[0].mode, 'http');
	const markdown = await readFile(config.output, 'utf8');
	assert.match(markdown, /## Results/);
	assert.ok(markdown.includes(`${baseUrl}/figures/1`));
	assert.equal(JSON.parse(await readFile(`${config.output}.report.json`, 'utf8')).outputWritten, true);
	await assert.rejects(clipPaper(config), /Output already exists/);
	assert.equal((await clipPaper({ ...config, overwrite: true })).exitCode, 0);
	assert.equal(await readFile(config.output, 'utf8'), markdown);
});

test('auto also falls back after an HTTP error', { timeout: 20000 }, async () => {
	const config = options('http-error-fallback', '/browser-only', ['--profile', path.join(directory, 'profile')]);
	const { exitCode, report } = await clipPaper(config);
	assert.equal(exitCode, 0);
	assert.deepEqual(report.attempts.map(attempt => attempt.status), ['error', 'passed-checks']);
	assert.match(report.attempts[0].error, /HTTP 403/);
});

test('uses a same-page canonical URL for notes while retaining the actual response URL', { timeout: 15000 }, async () => {
	const config = options('canonical', '/canonical?session=transient', ['--fetch', 'http']);
	const { exitCode, report } = await clipPaper(config);
	assert.equal(exitCode, 0);
	assert.equal(report.url, `${baseUrl}/canonical?session=transient`);
	assert.equal(report.contentUrl, `${baseUrl}/canonical`);
	assert.ok(!(await readFile(config.output, 'utf8')).includes('session=transient'));
	const other = options('external-canonical', '/external-canonical', ['--fetch', 'http']);
	assert.equal((await clipPaper(other)).report.contentUrl, `${baseUrl}/external-canonical`);
});

test('auto falls back from an incomplete HTTP page to a rendered browser page', { timeout: 25000 }, async () => {
	const config = options('dynamic', '/dynamic', ['--profile', path.join(directory, 'profile')]);
	const { exitCode, report } = await clipPaper(config);
	assert.equal(exitCode, 0);
	assert.deepEqual(report.attempts.map(attempt => [attempt.mode, attempt.status]), [
		['http', 'incomplete'], ['browser', 'passed-checks'],
	]);
	assert.ok((await readFile(config.output, 'utf8')).includes(paragraph.trim()));
});

test('preview CLI exits 2 and preserves an existing good Markdown even with --overwrite', { timeout: 15000 }, async () => {
	const output = path.join(directory, 'preserved.md');
	await writeFile(output, 'Previously accepted paper', 'utf8');
	await assert.rejects(run(process.execPath, [path.join(root, 'scripts/clip-paper.mjs'), `${baseUrl}/preview`,
		'-o', output, '--fetch', 'http', '--overwrite']), error => error.code === 2);
	assert.equal(await readFile(output, 'utf8'), 'Previously accepted paper');
	const report = JSON.parse(await readFile(`${output}.report.json`, 'utf8'));
	assert.equal(report.status, 'incomplete');
	assert.equal(report.outputWritten, false);
	assert.ok(report.attempts[0].quality.reasons.includes('subscription-preview'));
	assert.match(await readFile(report.attempts[0].html, 'utf8'), /subscription content/);
});

test('saved HTML is processed offline and creates no accepted output when checks fail', { timeout: 20000 }, async () => {
	const file = path.join(directory, 'saved.html');
	await writeFile(file, fullHtml, 'utf8');
	const count = requests;
	const config = options('offline', '/not-requested', ['--html', file, '--require-section', 'Methods']);
	assert.equal((await clipPaper(config)).exitCode, 0);
	const missing = options('offline-missing', '/not-requested', ['--html', file, '--require-section', 'Discussion']);
	assert.equal((await clipPaper(missing)).exitCode, 2);
	await assert.rejects(stat(missing.output), { code: 'ENOENT' });
	assert.equal(requests, count);
});

test('HTTP errors, non-HTML responses, and timeouts produce error reports without Markdown', { timeout: 20000 }, async () => {
	for (const route of ['/failure', '/json', '/slow']) {
		const config = options(`error-${route.slice(1)}`, route, ['--fetch', 'http', '--timeout', '1000', '--settle', '100']);
		const { exitCode, report } = await clipPaper(config);
		assert.equal(exitCode, 1);
		assert.equal(report.status, 'error');
		assert.ok(report.attempts[0].error);
		await assert.rejects(stat(config.output), { code: 'ENOENT' });
	}
});

test('unknown-publisher custom templates must retain a body; full-content templates remain supported', { timeout: 20000 }, async () => {
	const template = path.join(directory, 'template.json');
	await writeFile(template, JSON.stringify({ noteNameFormat: '{{title}}', noteContentFormat: 'Custom note: {{title}}', properties: [] }), 'utf8');
	const complete = options('custom', '/article', ['--fetch', 'http', '-t', template]);
	const rejected = await clipPaper(complete);
	assert.equal(rejected.exitCode, 2);
	assert.equal(rejected.report.attempts[0].quality.outputQuality.preservation.status, 'unverified');
	assert.deepEqual(rejected.report.attempts[0].quality.reasons, ['output-too-short', 'output-missing-main-sections']);
	await assert.rejects(stat(complete.output), { code: 'ENOENT' });
	await writeFile(template, JSON.stringify({ noteNameFormat: '{{title}}', noteContentFormat: 'Custom note: {{title}}\n\n{{content}}', properties: [] }));
	const accepted = await clipPaper(complete);
	assert.equal(accepted.exitCode, 0);
	assert.equal(accepted.report.attempts[0].quality.preservation.status, 'unverified');
	assert.equal(accepted.report.attempts[0].quality.coverage.status, 'heuristic-only');
	assert.match(await readFile(complete.output, 'utf8'), /Custom note: Spatial research fixture/);
	const preview = options('custom-preview', '/preview', ['--fetch', 'http', '-t', template]);
	assert.equal((await clipPaper(preview)).exitCode, 2);
	await assert.rejects(stat(preview.output), { code: 'ENOENT' });
});
