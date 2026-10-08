import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { parseHTML } from 'linkedom';
import { MathMLToLaTeX } from 'mathml-to-latex';
import { browserFlags, fetchPage, resolveBrowserOptions } from './fetch-page.mjs';
import { localizeImages } from './paper-assets.mjs';
import { checkFigureCaptions } from './paper-captions.mjs';
import { assessPaperIdentity } from './paper-metadata.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cliPath = path.join(root, 'dist/cli.cjs');
const defaultTemplate = path.join(root, 'src/utils/fixtures/templates/minimal.json');
const exec = promisify(execFile);
const maxHtmlBytes = 30 * 1024 * 1024;
const previewPattern = /this is a preview of subscription content|sign in to access (?:the )?full (?:text|article)|purchase access to (?:the|this) article/i;

const usage = `Usage: node scripts/clip-paper.mjs <url> -o <paper.md> [options]

  -o, --output <path>         Destination Markdown (required)
  -t, --template <path>       Clipper template JSON or directory (default: minimal)
      --fetch <mode>          auto, http, or browser (default: auto)
      --html <path>           Read saved HTML (no page fetch/browser)
      --download-assets      Download image attachments; enables image network requests
      --min-words <count>     Minimum body words before References (default: 1000)
      --require-section <h>  Required level-2 heading; repeat for multiple headings
      --overwrite            Replace existing output only after checks pass
      --profile <path>       Dedicated Playwright profile
      --login                Start browser mode and pause for manual login
      --headed               Show the browser (selects browser mode in auto)
      --wait-for <selector>  Browser readiness selector (selects browser mode in auto)
      --timeout <ms>         Timeout per fetch/conversion phase (default: 60000)
      --settle <ms>          Browser text stability interval (default: 1500)
  -h, --help                  Show this help

Exit: 0 passed basic checks, 1 operational error, 2 incomplete/blocked content.
Writes <paper.md>.report.json and preserves diagnostics under <paper.md>.runs/.
Checks are heuristic, not proof of full-text completeness.
Known Nature legends are checked against source HTML before publishing.
`;

export function parseOptions(args) {
	const { values, positionals } = parseArgs({
		args, allowPositionals: true,
		options: {
			...browserFlags,
			output: { type: 'string', short: 'o' },
			template: { type: 'string', short: 't' },
			fetch: { type: 'string', default: 'auto' },
			html: { type: 'string' },
			'min-words': { type: 'string', default: '1000' },
			'require-section': { type: 'string', multiple: true, default: [] },
			overwrite: { type: 'boolean', default: false },
			'download-assets': { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h' },
		},
	});
	if (values.help) return { help: true };
	if (positionals.length !== 1) throw new Error('Provide exactly one HTTP(S) URL.');
	const url = new URL(positionals[0]);
	if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported.');
	if (!values.output || path.extname(values.output).toLowerCase() !== '.md') throw new Error('--output must name a .md file.');
	if (!['auto', 'http', 'browser'].includes(values.fetch)) throw new Error('--fetch must be auto, http, or browser.');
	const needsBrowser = values.login || values.headed || values['wait-for'];
	if (values.html && (values.fetch !== 'auto' || needsBrowser || values.profile)) {
		throw new Error('--html cannot be combined with fetch mode or browser options.');
	}
	if (values.fetch === 'http' && needsBrowser) throw new Error('Browser interaction options cannot be used with --fetch http.');
	const minWords = Number(values['min-words']);
	if (!Number.isSafeInteger(minWords) || minWords < 1) throw new Error('--min-words must be a positive integer.');
	const requiredSections = values['require-section'].map(value => value.trim());
	if (requiredSections.some(value => !value)) throw new Error('--require-section cannot be empty.');
	const output = path.resolve(values.output);
	const htmlPath = values.html ? path.resolve(values.html) : undefined;
	const template = path.resolve(values.template ?? defaultTemplate);
	if ([htmlPath, template].some(input => input && input.toLowerCase() === output.toLowerCase())) {
		throw new Error('Output must not replace an input file.');
	}
	return {
		...resolveBrowserOptions(values), url: url.href, output, htmlPath, template, minWords, requiredSections,
		mode: values.html ? 'file' : needsBrowser ? 'browser' : values.fetch,
		overwrite: values.overwrite, downloadAssets: values['download-assets'],
	};
}

export function assessMarkdown(markdown, { minWords, requiredSections = [] }, page = {}) {
	const body = markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
	const headings = [...body.matchAll(/^##\s+(.+?)\s*#*\s*$/gm)].map(match => match[1].replace(/[*_`]/g, '').trim());
	const beforeReferences = body.split(/^##\s+(?:References|Bibliography)\s*\r?$/im)[0];
	const words = text => text.trim().split(/\s+/).filter(Boolean).length;
	const mainSections = [...new Set(headings.filter(heading => /^(?:\d+[.\s]*)?(?:introduction|background|main|results|discussion|methods|materials and methods|methodology|conclusions?)(?:$|[\s:])/i.test(heading)))];
	const reasons = [];
	if (page.preview || previewPattern.test(body)) reasons.push('subscription-preview');
	if (page.challenge) reasons.push('access-challenge');
	if (page.unrenderedEquations) reasons.push('unrendered-equations');
	if (page.figureCaptions?.status === 'failed') reasons.push('figure-captions');
	if (page.paperIdentity?.status === 'failed') reasons.push('paper-identity');
	if (words(beforeReferences) < minWords) reasons.push('too-short');
	if (mainSections.length < 2) reasons.push('missing-main-sections');
	for (const heading of requiredSections) {
		if (!headings.some(found => found.toLowerCase() === heading.toLowerCase())) reasons.push(`missing-section:${heading}`);
	}
	return { passed: reasons.length === 0, bodyWords: words(body), wordsBeforeReferences: words(beforeReferences), headings, mainSections, reasons,
		...(page.figureCaptions ? { figureCaptions: page.figureCaptions } : {}),
		...(page.paperIdentity ? { paperIdentity: page.paperIdentity } : {}) };
}

export function normalizeMathJaxTex(html) {
	const { document } = parseHTML(html);
	let count = 0;
	for (const element of document.querySelectorAll('.mathjax-tex')) {
		if (element.children.length || element.closest('pre, code, script, style, textarea, math')) continue;
		const text = element.textContent.trim();
		const delimiters = [['\\(', '\\)', 'inline'], ['\\[', '\\]', 'block'], ['$$', '$$', 'block']];
		const delimiter = delimiters.find(([start, end]) => text.startsWith(start) && text.endsWith(end));
		if (!delimiter) continue;
		const [start, end, display] = delimiter;
		const latex = text.slice(start.length, -end.length).trim();
		if (!latex) continue;
		// Static exports omit the library script that normally enables Defuddle's
		// raw-TeX detection. Mark only explicitly labelled publisher math as MathML.
		const math = document.createElement('math');
		math.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
		math.setAttribute('display', display);
		math.setAttribute('data-latex', latex);
		math.textContent = latex;
		element.replaceChildren(math);
		count++;
	}
	return { html: count ? document.toString() : html, count };
}

export function normalizePublisherLinks(html, url) {
	const host = new URL(url).hostname;
	const selector = host === 'journals.plos.org' ? 'a.ref-tip' : /(^|\.)frontiersin\.org$/.test(host) ? 'a.ArticleReference' : null;
	if (!selector) return { html, count: 0 };
	const { document } = parseHTML(html);
	let count = 0;
	for (const link of document.querySelectorAll(selector)) {
		const href = link.getAttribute('href');
		if (!href?.startsWith('#') || href.length === 1 || !link.textContent.trim() || link.closest('pre, code')) continue;
		// Defuddle removes fragment links whose class contains "ref". Preserve the
		// publisher's visible label and original destination without inventing notes.
		link.setAttribute('href', new URL(href, url).href);
		link.classList.remove('ref-tip', 'ArticleReference');
		count++;
	}
	return { html: count ? document.toString() : html, count };
}

export function normalizeMathMLForReader(html) {
	const { document } = parseHTML(html);
	let count = 0;
	let ellipses = 0;
	let nestedTables = 0;
	for (const math of document.querySelectorAll('math')) {
		if (math.closest('pre, code, script, style, textarea') || math.hasAttribute('data-latex') ||
			math.hasAttribute('alttext') || math.hasAttribute('data-math') ||
			math.querySelector('annotation, mlabeledtr') ||
			math.parentElement?.querySelector('script[type^="math/tex"]')) continue;
		const dots = [...math.querySelectorAll('mo')].filter(node => node.textContent.trim() === '\u22ef');
		const nested = math.querySelector('mtable mtable');
		if ((!dots.length && !nested) || math.textContent.includes('\u2026')) continue;
		// The existing converter emits unsupported \\hdots for U+22EF. Keep the
		// original MathML and supply equivalent TeX only when every alias is accounted for.
		// Pre-convert nested tables before HTML cleanup can flatten their structure.
		const latex = MathMLToLaTeX.convert(math.outerHTML);
		const aliases = [...latex.matchAll(/\\hdots(?![a-zA-Z])/g)];
		if (aliases.length !== dots.length) continue;
		math.setAttribute('data-latex', latex.replace(/\\hdots(?![a-zA-Z])/g, '\\cdots'));
		count++;
		if (dots.length) ellipses++;
		if (nested) nestedTables++;
	}
	return { html: count ? document.toString() : html, count, ellipses, nestedTables };
}

export function normalizePublisherFigures(html, url) {
	if (!/(^|\.)frontiersin\.org$/.test(new URL(url).hostname)) return { html, count: 0 };
	const { document } = parseHTML(html);
	let count = 0;
	for (const button of document.querySelectorAll('.ArticleFigure button.ArticleFigure__figureButton')) {
		if (!button.querySelector('figure')) continue;
		// The publisher wraps the figure AND caption in its lightbox button.
		// Unwrap only this content button before Defuddle removes UI controls.
		button.replaceWith(...button.childNodes);
		count++;
	}
	return { html: count ? document.toString() : html, count };
}

function inspectHtml(html, finalUrl) {
	const { document } = parseHTML(html);
	let contentUrl = finalUrl;
	const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
	if (canonical) {
		try {
			const url = new URL(canonical, finalUrl);
			const actual = new URL(finalUrl);
			if (url.origin === actual.origin && url.pathname === actual.pathname) contentUrl = url.href;
		} catch { /* Ignore malformed publisher metadata. */ }
	}
	for (const element of document.querySelectorAll('script, style, noscript, template, [hidden], [aria-hidden="true"]')) element.remove();
	const title = document.title;
	const unrenderedEquations = /(^|\.)frontiersin\.org$/.test(new URL(finalUrl).hostname) &&
		[...document.querySelectorAll('a.ArticleReference[href^="#e"]')].some(link => {
			const id = link.getAttribute('href').slice(1);
			return /^e\d+$/.test(id) && !document.getElementById(id);
		});
	return {
		contentUrl,
		title,
		unrenderedEquations,
		preview: previewPattern.test((document.body?.textContent ?? '').replace(/\s+/g, ' ')),
		challenge: /^(?:just a moment|access denied|attention required|client challenge|verify (?:you are|you're) human|security (?:check|verification))/i.test(title.trim()),
	};
}

async function fetchHttp(url, timeout) {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(timeout),
		headers: { Accept: 'text/html, application/xhtml+xml' },
	});
	const contentType = response.headers.get('content-type') ?? '';
	if (!response.ok || !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
		await response.body?.cancel();
		throw new Error(!response.ok ? `HTTP ${response.status} at ${response.url}` : `Expected HTML, received ${contentType || 'no Content-Type'}.`);
	}
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		if (size > maxHtmlBytes) throw new Error('HTML exceeds the 30 MiB capture limit.');
		chunks.push(chunk);
	}
	return { html: Buffer.concat(chunks).toString('utf8'), report: { url: response.url, httpStatus: response.status, capturedAt: new Date().toISOString() } };
}

async function convert(htmlPath, url, template, timeout) {
	try {
		const { stdout } = await exec(process.execPath, [cliPath, url, '--html', htmlPath, '-t', template], {
			timeout, maxBuffer: maxHtmlBytes, windowsHide: true,
		});
		return stdout;
	} catch (error) {
		throw new Error(`Clipper conversion failed: ${error.stderr?.trim() || error.message}`);
	}
}

export async function clipPaper(options) {
	await access(cliPath).catch(() => { throw new Error('Build the Clipper CLI first: npm run build:cli'); });
	const templateInfo = await stat(options.template);
	if (!templateInfo.isDirectory()) JSON.parse(await readFile(options.template, 'utf8'));
	if (options.login && !process.stdin.isTTY) throw new Error('--login requires an interactive terminal.');
	try {
		const outputInfo = await stat(options.output);
		if (!outputInfo.isFile() || !options.overwrite) throw new Error('Output already exists. Choose a different name or use --overwrite for a file.');
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	await mkdir(`${options.output}.runs`, { recursive: true });
	const directory = await mkdtemp(path.join(`${options.output}.runs`, 'run-'));
	const report = {
		requestedUrl: options.url, mode: options.mode, startedAt: new Date().toISOString(),
		status: 'error', output: options.output, outputWritten: false, artifactDirectory: directory,
		checks: { minWords: options.minWords, requiredSections: options.requiredSections, minMainSections: 2, figureCaptions: 'nature-v1', expectedDoi: options.expectedDoi },
		attempts: [],
	};
	let exitCode = 1;
	try {
		const modes = options.mode === 'auto' ? ['http', 'browser'] : [options.mode];
		for (const mode of modes) {
			const attempt = { mode, status: 'error' };
			report.attempts.push(attempt);
			console.error(`Fetching via ${mode}: ${options.url}`);
			let captured;
			try {
				if (mode === 'file') {
					if ((await stat(options.htmlPath)).size > maxHtmlBytes) throw new Error('HTML exceeds the 30 MiB capture limit.');
					captured = { html: await readFile(options.htmlPath, 'utf8'), report: { url: options.url } };
				} else if (mode === 'http') captured = await fetchHttp(options.url, options.timeout);
				else captured = await fetchPage(options);
				if (Buffer.byteLength(captured.html, 'utf8') > maxHtmlBytes) throw new Error('HTML exceeds the 30 MiB capture limit.');
			} catch (error) {
				attempt.error = error.message;
				console.error(attempt.error);
				continue;
			}
			attempt.url = captured.report.url;
			attempt.capture = captured.report;
			attempt.html = path.join(directory, `${mode}.html`);
			await writeFile(attempt.html, captured.html, 'utf8');
			const page = inspectHtml(captured.html, attempt.url);
			attempt.contentUrl = page.contentUrl;
			const prepared = normalizeMathJaxTex(captured.html);
			const mathML = normalizeMathMLForReader(prepared.html);
			const links = normalizePublisherLinks(mathML.html, attempt.contentUrl);
			const figures = normalizePublisherFigures(links.html, attempt.contentUrl);
			let conversionHtml = attempt.html;
			if (prepared.count || mathML.count || links.count || figures.count) {
				attempt.preparedHtml = path.join(directory, `${mode}.prepared.html`);
				attempt.normalizations = {};
				if (prepared.count) attempt.normalizations.mathJaxTex = prepared.count;
				if (mathML.ellipses) attempt.normalizations.mathMLEllipses = mathML.ellipses;
				if (mathML.nestedTables) attempt.normalizations.mathMLTables = mathML.nestedTables;
				if (links.count) attempt.normalizations.publisherLinks = links.count;
				if (figures.count) attempt.normalizations.publisherFigures = figures.count;
				await writeFile(attempt.preparedHtml, figures.html, 'utf8');
				conversionHtml = attempt.preparedHtml;
			}
			const extracted = await convert(conversionHtml, attempt.contentUrl, defaultTemplate, options.timeout);
			attempt.markdown = path.join(directory, `${mode}.md`);
			await writeFile(attempt.markdown, extracted, 'utf8');
			page.preview ||= captured.report.status === 'subscription-preview';
			attempt.title = page.title;
			page.figureCaptions = checkFigureCaptions(captured.html, extracted, attempt.contentUrl);
			if (options.expectedDoi) page.paperIdentity = assessPaperIdentity(captured.html, options.expectedDoi);
			attempt.quality = assessMarkdown(extracted, options, page);
			if (!attempt.quality.passed) {
				attempt.status = 'incomplete';
				console.error(`Content check failed: ${attempt.quality.reasons.join(', ')}`);
				continue;
			}
			let markdown = options.template === defaultTemplate ? extracted : await convert(conversionHtml, attempt.contentUrl, options.template, options.timeout);
			attempt.quality.outputFigureCaptions = options.template === defaultTemplate ? page.figureCaptions
				: checkFigureCaptions(captured.html, markdown, attempt.contentUrl);
			if (attempt.quality.outputFigureCaptions.status === 'failed') {
				attempt.renderedMarkdown = path.join(directory, `${mode}.rendered.md`);
				await writeFile(attempt.renderedMarkdown, markdown, 'utf8');
				attempt.status = 'incomplete';
				attempt.quality.passed = false;
				attempt.quality.reasons.push('output-figure-captions');
				console.error('Content check failed: output-figure-captions (custom template output).');
				break;
			}
			if (options.downloadAssets) {
				console.error('Downloading image attachments (without browser credentials)...');
				const assets = await localizeImages(markdown, { output: options.output, url: attempt.contentUrl, timeout: options.timeout });
				markdown = assets.markdown;
				report.assets = assets.report;
				console.error(`Images: ${report.assets.downloaded} downloaded, ${report.assets.failed} unresolved.`);
			}
			const candidate = path.join(directory, 'accepted.md');
			await writeFile(candidate, markdown, 'utf8');
			if (options.overwrite) {
				// Stage on the destination filesystem before replacing the previous paper.
				const staged = path.join(directory, 'publish.md');
				await copyFile(candidate, staged);
				await rename(staged, options.output);
			} else await copyFile(candidate, options.output, constants.COPYFILE_EXCL);
			attempt.status = report.status = 'passed-checks';
			report.outputWritten = true;
			report.url = attempt.url;
			report.contentUrl = attempt.contentUrl;
			report.capturedAt = mode === 'file' ? options.capturedAt ?? null : captured.report.capturedAt ?? null;
			exitCode = 0;
			break;
		}
		if (!report.outputWritten) {
			report.status = report.attempts.some(attempt => attempt.status === 'incomplete') ? 'incomplete' : 'error';
			exitCode = report.status === 'incomplete' ? 2 : 1;
		}
	} catch (error) {
		report.error = error.message;
	} finally {
		report.finishedAt = new Date().toISOString();
		const serialized = `${JSON.stringify(report, null, 2)}\n`;
		await writeFile(path.join(directory, 'report.json'), serialized, 'utf8');
		await writeFile(`${options.output}.report.json`, serialized, 'utf8');
	}
	return { exitCode, report };
}

export async function main(args = process.argv.slice(2)) {
	const options = parseOptions(args);
	if (options.help) { console.log(usage); return 0; }
	const { exitCode, report } = await clipPaper(options);
	console.error(`Status: ${report.status}\nReport: ${options.output}.report.json`);
	if (report.outputWritten) console.error(`Markdown: ${options.output}\nBasic checks passed; this is not a guarantee of full-text completeness.`);
	else console.error(report.error ?? 'No new Markdown published. Inspect the retained diagnostics.');
	if (report.assets?.failed) console.error('Warning: some images remain remote/unresolved. This paper is not fully offline; see report.assets.items.');
	return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(code => { process.exitCode = code; }).catch(error => {
		console.error(error.message ?? error);
		process.exitCode = 1;
	});
}
