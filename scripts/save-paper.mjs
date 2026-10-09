import { lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { clip, parseOptions as clipOptions } from './clip.mjs';
import { browserFlags } from './fetch-page.mjs';
import { readExportPair } from './import-papers.mjs';
import { validateVaultDestination } from './archive-papers.mjs';
import { canonicalUrl } from './paper-metadata.mjs';
import { classifyQuery, resolvePaper } from './resolve-paper.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const common = ['output-dir', 'vault', 'papers-dir', 'download-assets', 'overwrite', 'min-words', 'require-section', 'timeout'];
const browser = ['fetch', 'profile', 'login', 'headed', 'wait-for', 'settle'];
const usage = `Usage: node scripts/save-paper.mjs "<title | DOI | URL>" [options]

Resolve a journal article, then reuse the existing HTML-to-Markdown pipeline.
stdout is one JSON result; progress goes to stderr. No AI or PDF conversion.

  --resolve-only            Resolve metadata only; no capture or filesystem writes
  --html <export.html>      Use one authorized Clipper HTML/JSON pair after resolution
  -o, --output-dir <dir>    Conversion/report directory (default: output/browser-fetch/agent)
  --vault <dir>            Optional Vault destination; existing notes are never overwritten
  --papers-dir <relative>  Vault paper subdirectory (default: Papers)
  --download-assets        Opt into local image downloads, including with --html
  --overwrite              Intentionally regenerate conversion output, never Vault notes
  --mailto <email>         Optional contact address sent to Crossref
  --resolve-timeout <ms>   Metadata request timeout (default: 15000)
  --min-words <count>      Main-section prose threshold (default: 1000)
  --require-section <h>    Required section, repeatable
  --fetch auto|http|browser, --profile, --login, --headed, --wait-for,
  --timeout, --settle      Existing capture options (browser options not with --html)

Title resolution examines up to 20 Crossref journal-article candidates. Only a
unique normalized exact title of at least 40 characters continues automatically.
Other matches need human selection: rerun with the confirmed DOI, never candidate
rank alone. A DOI must match publisher DOI metadata before publishing/archiving.
Login/captcha/institutional access may need user intervention. A saved result is
not proof of complete scientific equivalence. No automatic retries or purchases.

Exit: 0 saved/duplicate/resolved, 1 failed/not-found, 2 needs-access/incomplete,
      3 needs-selection/existing-unverified. Branch on JSON status, not exit alone.
For machine calls use node directly; npm itself may print extra lifecycle output.
`;

function forward(values, names) {
	const args = [];
	for (const name of names) {
		const value = values[name];
		if (value === true) args.push(`--${name}`);
		else if (Array.isArray(value)) for (const entry of value) args.push(`--${name}`, entry);
		else if (typeof value === 'string') args.push(`--${name}`, value);
	}
	return args;
}

export function parseOptions(args) {
	const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
		...browserFlags, 'output-dir': { type: 'string', short: 'o' }, vault: { type: 'string' }, 'papers-dir': { type: 'string' },
		'download-assets': { type: 'boolean', default: false }, overwrite: { type: 'boolean', default: false },
		'min-words': { type: 'string', default: '1000' }, 'require-section': { type: 'string', multiple: true, default: [] },
		fetch: { type: 'string' }, html: { type: 'string' }, mailto: { type: 'string' },
		'resolve-only': { type: 'boolean', default: false }, 'resolve-timeout': { type: 'string', default: '15000' }, help: { type: 'boolean', short: 'h' },
	} });
	if (values.help) return { help: true };
	if (positionals.length !== 1) throw new Error('Provide exactly one title, DOI or URL.');
	const input = classifyQuery(positionals[0]);
	const resolveTimeout = Number(values['resolve-timeout']);
	if (!Number.isSafeInteger(resolveTimeout) || resolveTimeout < 1 || resolveTimeout > 2147483647) throw new Error('--resolve-timeout must be a positive integer.');
	if (values.mailto !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.mailto)) throw new Error('--mailto must be an email address.');
	if (values.html !== undefined && (!values.html.trim() || !/\.html$/i.test(values.html))) throw new Error('--html must name one Clipper-exported .html file with its sidecar.');
	if (values.html && values['resolve-only']) throw new Error('--html and --resolve-only cannot be combined.');
	const explicitBrowser = browser.filter(name => tokens.some(token => token.kind === 'option' && token.name === name));
	const outputDir = path.resolve(values['output-dir'] ?? path.join(root, 'output/browser-fetch/agent'));
	const forwardArgs = forward({ ...values, 'output-dir': values['output-dir'] ?? outputDir }, [...common, ...explicitBrowser]);
	const htmlPath = values.html ? path.resolve(values.html) : undefined;
	// Validate existing path/flag contracts before metadata requests or writes.
	clipOptions([htmlPath ?? 'https://example.com/preflight', ...forwardArgs]);
	return { query: input.query, resolveOnly: values['resolve-only'], resolveTimeout, mailto: values.mailto, htmlPath, outputDir, forwardArgs };
}

function outcome(result) {
	const item = result.report.items[0];
	const common = { clipReport: result.reportPath, conversion: item, output: null, saved: false };
	if (item?.archive?.status === 'archived') return { ...common, status: 'saved', exitCode: 0, saved: true, output: item.archive.output };
	if (item?.archive?.status === 'duplicate') return { ...common, status: 'duplicate', exitCode: 0, output: item.archive.output };
	if (item?.accessLimited || [item?.quality, item?.archive?.quality].some(quality => quality?.reasons.some(reason => ['subscription-preview', 'access-challenge', 'output-subscription-preview', 'output-access-challenge'].includes(reason)))) return { ...common, status: 'needs-access', exitCode: 2 };
	if (item?.status === 'incomplete' || item?.archive?.quality?.reasons.length || item?.assets?.failed || item?.archive?.code === 'incomplete-assets' || item?.archive?.reason === 'incomplete-assets') return { ...common, status: 'incomplete', exitCode: 2 };
	if (result.exitCode !== 0) return { ...common, status: 'failed', exitCode: 1, error: item?.archive?.error || item?.error || result.report.error || 'Capture or archive failed.' };
	if (item?.status === 'skipped') return { ...common, status: 'existing-unverified', exitCode: 3, existingOutput: item.output };
	if (item?.status === 'success') return { ...common, status: 'saved', exitCode: 0, saved: true, output: item.output };
	return { ...common, status: 'failed', exitCode: 1, error: 'Pipeline returned no accepted paper.' };
}

export async function savePaper(options, { resolve = resolvePaper, runClip = clip } = {}) {
	const report = { schemaVersion: 1, query: options.query, startedAt: new Date().toISOString(), status: 'failed', saved: false, output: null,
		limitations: ['Content checks do not prove full-text completeness.', 'Title matching is limited to the returned Crossref journal-article candidates.', 'Existing Vault notes are not overwritten or revalidated.'] };
	let reportPath;
	try {
		const preflight = clipOptions([options.htmlPath ?? 'https://example.com/preflight', ...options.forwardArgs]);
		if (preflight.archive) await validateVaultDestination(preflight.archive, [preflight.outputDir]);
		if (options.htmlPath && !(await lstat(options.htmlPath)).isFile()) throw new Error('--html must be a regular exported HTML file.');
		if (!options.resolveOnly) {
			const parent = path.join(options.outputDir, '_papers');
			await mkdir(parent, { recursive: true });
			reportPath = path.join(await mkdtemp(path.join(parent, 'run-')), 'report.json');
			report.reportPath = reportPath;
			await writeFile(reportPath, JSON.stringify({ ...report, status: 'resolving' }, null, 2) + '\n');
		}
		const resolution = report.resolution = await resolve(options.query, { timeout: options.resolveTimeout, mailto: options.mailto });
		if (resolution.status !== 'resolved') {
			report.status = resolution.status;
			report.exitCode = resolution.status === 'needs-selection' ? 3 : 1;
			report.nextStep = 'Ask the user to confirm a candidate DOI or provide a more complete title. Do not select by rank or invent a DOI.';
		} else if (options.resolveOnly) {
			report.status = 'resolved'; report.exitCode = 0;
			report.nextStep = 'Resolution only: no article was fetched or saved.';
		} else {
			const selected = resolution.selected;
			if (options.htmlPath && !selected.doi) {
				const pair = await readExportPair(options.htmlPath);
				if (canonicalUrl(pair.url) !== canonicalUrl(selected.url)) throw new Error('Exported page URL does not match the requested URL. Use the confirmed DOI to handle legitimate publisher redirects.');
			}
			const config = clipOptions([options.htmlPath ?? selected.url, ...options.forwardArgs]);
			config.config.expectedDoi = selected.doi ?? undefined;
			if (reportPath) await writeFile(reportPath, JSON.stringify({ ...report, status: 'capturing' }, null, 2) + '\n');
			Object.assign(report, outcome(await runClip(config)));
			report.nextStep = report.conversion?.nextStep?.message ?? 'Inspect the conversion report.';
		}
	} catch (error) {
		report.status = 'failed'; report.exitCode = 1; report.error = error.message;
		if (error.code) report.code = error.code;
		if (error.retryAfter) report.retryAfter = error.retryAfter;
		report.nextStep = 'Inspect the error; no successful save is claimed. Resolve access, metadata or path problems before retrying.';
	}
	report.finishedAt = new Date().toISOString();
	if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
	return report;
}

export async function main(args = process.argv.slice(2)) {
	try {
		const options = parseOptions(args);
		if (options.help) { console.log(usage); return 0; }
		const result = await savePaper(options);
		console.log(JSON.stringify(result, null, 2));
		return result.exitCode;
	} catch (error) {
		console.log(JSON.stringify({ schemaVersion: 1, status: 'failed', exitCode: 1, saved: false, output: null, error: error.message }));
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(code => { process.exitCode = code; });
}
