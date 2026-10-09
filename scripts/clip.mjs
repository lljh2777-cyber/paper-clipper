import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { clipPaper, parseOptions as parsePaperOptions } from './clip-paper.mjs';
import { browserFlags } from './fetch-page.mjs';
import { importPapers, parseOptions as parseImportOptions } from './import-papers.mjs';
import { archivePapers, parseOptions as parseArchiveOptions, validateVaultDestination } from './archive-papers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const commonFlags = ['template', 'min-words', 'require-section', 'timeout', 'overwrite', 'download-assets'];
const urlFlags = ['fetch', 'profile', 'login', 'headed', 'wait-for', 'settle'];
const usage = `Usage: npm run clip -- <url | file.html | directory> [options]

Automatically capture a URL or import Clipper HTML/JSON export pairs.
Imports stay offline unless --download-assets is set.
Existing Markdown is skipped by default. Original files are preserved.

Common options:
  -o, --output-dir <path>    Destination DIRECTORY for either route
  -t, --template <path>      Clipper template JSON or directory
      --min-words <count>    Minimum main-section prose words (default: 1000)
      --require-section <h> Required nonempty section; repeat as needed
      --timeout <ms>         Timeout per fetch/conversion phase (default: 60000)
      --overwrite            Replace Markdown only after checks pass
      --download-assets      Save image attachments and use relative image paths
      --vault <directory>    Archive accepted Markdown and local images into a Vault
      --papers-dir <path>    Relative paper folder inside --vault (default: Papers)
  -h, --help                 Show this help

URL-only options:
      --output <file.md>     Exact Markdown path instead of --output-dir
      --fetch <mode>         auto (HTTP then browser), http, or browser
      --profile <path>       Dedicated browser profile, not everyday Chrome
      --login                Open browser and wait for manual login
      --headed               Show browser during capture
      --wait-for <selector>  Wait for an element before browser capture
      --settle <ms>          Stable text interval (default: 1500; less than timeout)

Defaults: URLs -> output/browser-fetch/papers/<URL-based-name>.md
          exports -> output/browser-fetch/imported/<HTML-basename>.md
Local input requires a matching <file.html>.json. Scans are not recursive.
No access rights are transferred from your everyday browser. For limited access,
export HTML with Clipper from an authorized tab, then import the saved pair.

Writes a unified _clips/run-*/report.json alongside the route-specific reports.
Exit: 0 success/skipped, 1 failures or empty input, 2 incomplete content only.
With --vault, any archiving failure also exits 1. Vault notes are never overwritten.
Skipped conversion files are revalidated before archiving. Images must be local;
--vault alone does not opt into image network requests. Use --download-assets.
For a no-write archive preview, use clip:vault --dry-run on converted outputs.
Original clip:paper and clip:import commands remain available.
`;

function forwardFlags(values, names) {
	const args = [];
	for (const name of names) {
		const value = values[name];
		if (value === true) args.push(`--${name}`);
		else if (typeof value === 'string') args.push(`--${name}`, value);
		else if (Array.isArray(value)) for (const entry of value) args.push(`--${name}`, entry);
	}
	return args;
}

function urlFilename(url) {
	const key = new URL(url);
	key.hash = '';
	const label = `${key.hostname}-${key.pathname.split('/').filter(Boolean).at(-1) || 'index'}`
		.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80);
	// A stable URL identifier prevents different paths/queries sharing a basename.
	const id = createHash('sha256').update(key.href).digest('hex').slice(0, 12);
	return `${label}-${id}.md`;
}

function withArchive(options, values) {
	if (!values.vault) return options;
	const config = parseArchiveOptions([path.join(options.outputDir, 'paper.md'), '--vault', values.vault,
		'--papers-dir', values['papers-dir'] ?? 'Papers']);
	const relative = path.relative(config.vault, options.outputDir);
	if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
		throw new Error('Conversion output must be outside the destination Vault. --overwrite never applies to Vault notes.');
	}
	return { ...options, archive: config };
}

export function parseOptions(args) {
	const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
		...browserFlags,
		'output-dir': { type: 'string', short: 'o' },
		output: { type: 'string' },
		template: { type: 'string', short: 't' },
		fetch: { type: 'string', default: 'auto' },
		'min-words': { type: 'string', default: '1000' },
		'require-section': { type: 'string', multiple: true, default: [] },
		overwrite: { type: 'boolean', default: false },
		'download-assets': { type: 'boolean', default: false },
		vault: { type: 'string' },
		'papers-dir': { type: 'string' },
		help: { type: 'boolean', short: 'h' },
	} });
	if (values.help) return { help: true };
	if (positionals.length !== 1 || !positionals[0].trim()) throw new Error('Provide one HTTP(S) URL, exported HTML file, or directory.');
	for (const name of ['output-dir', 'output', 'template', 'profile', 'wait-for', 'vault', 'papers-dir']) {
		if (values[name] !== undefined && !values[name].trim()) throw new Error(`--${name} cannot be empty.`);
	}
	if (values['papers-dir'] !== undefined && values.vault === undefined) throw new Error('--papers-dir requires --vault.');
	const input = positionals[0];
	const isDrivePath = /^[a-z]:/i.test(input);
	const isUrl = !isDrivePath && /^[a-z][a-z0-9+.-]*:/i.test(input.trim());
	if (!isUrl) {
		const explicitUrlFlag = tokens.find(token => token.kind === 'option' && [...urlFlags, 'output'].includes(token.name));
		if (explicitUrlFlag) throw new Error(`--${explicitUrlFlag.name} is only supported for URLs. Local exports are imported offline; use --output-dir for their destination.`);
		const args = [path.resolve(input), ...forwardFlags(values, commonFlags)];
		if (values['output-dir']) args.push('--output-dir', values['output-dir']);
		const config = parseImportOptions(args);
		return withArchive({ route: 'import', input: config.input, outputDir: config.outputDir, config }, values);
	}
	let url;
	try { url = new URL(input.trim()); }
	catch { throw new Error('Invalid URL. Provide a complete HTTP(S) URL.'); }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new Error('URL must use HTTP(S) without embedded credentials.');
	}
	if (values.output && values['output-dir']) throw new Error('Choose --output for a Markdown file or --output-dir for a directory, not both.');
	const outputDir = values.output ? path.dirname(path.resolve(values.output))
		: path.resolve(values['output-dir'] ?? path.join(root, 'output/browser-fetch/papers'));
	const output = values.output ? path.resolve(values.output) : path.join(outputDir, urlFilename(url.href));
	const config = parsePaperOptions([url.href, '--output', output, ...forwardFlags(values, [...commonFlags, ...urlFlags])]);
	return withArchive({ route: 'url', input: url.href, outputDir, config }, values);
}

export function nextStep(item, route) {
	if ((item.archive?.quality?.reasons.includes('paper-identity') || item.quality?.reasons.includes('paper-identity')) &&
		!item.accessLimited && !item.quality?.reasons.some(reason => ['subscription-preview', 'access-challenge'].includes(reason))) return {
		code: 'verify-paper-identity', message: 'Publisher DOI metadata did not verify the requested paper. Inspect quality.paperIdentity (or archive.quality.paperIdentity), confirm the DOI and source page, then use a fresh matching export or capture. Do not bypass this check or overwrite an existing Vault note.',
	};
	if (item.archive?.quality?.reasons.some(reason => reason.includes('figure-captions')) ||
		item.quality?.reasons.some(reason => reason.includes('figure-captions'))) return {
		code: 'repair-figure-captions', message: 'Source figure legends could not be verified in the Markdown. Inspect quality.figureCaptions / outputFigureCaptions for figure titles and errors. Use the current converter and a full-content template, then intentionally regenerate the conversion with --overwrite. Existing Vault notes are not overwritten; export again only if the saved source itself is incomplete.',
	};
	if (item.archive?.quality?.reasons.some(reason => reason.includes('source-sections')) ||
		item.quality?.reasons.some(reason => reason.includes('source-sections'))) return {
		code: 'repair-source-sections', message: 'Source sections or plain prose could not be verified. Inspect quality.sourceSections / outputSourceSections (or archive.quality.sourceSections) for headings and paragraph numbers. Use a full-content template and inspect the retained HTML before intentionally reconverting. Existing Vault notes are not overwritten; skipped math paragraphs are not verified by this check.',
	};
	if (item.archive?.status === 'archived') return {
		code: 'read-vault-note', message: 'Open the archived note in Obsidian and review formulas, tables and captions. The source Markdown and images were preserved.',
	};
	if (item.archive?.status === 'duplicate') return {
		code: 'review-vault-existing', message: 'This identity already exists in the Vault. Its note and annotations were not changed; duplicate status does not revalidate that existing note.',
	};
	if (item.archive?.status === 'failed' || item.archive?.reason === 'incomplete-assets') {
		if (item.archive.code === 'incomplete-assets' || item.archive.reason === 'incomplete-assets') return {
			code: 'repair-assets-before-archive', message: 'The Vault was not updated for this paper because images are unresolved. Inspect image errors, then intentionally reconvert with --download-assets --overwrite and the same --vault. Overwrite applies only to conversion outputs.',
		};
		return { code: 'inspect-vault-error', message: 'This paper was not archived. Inspect the archive error/report; correct the Vault path, metadata conflict, saved-source mismatch or current content requirements. Existing Vault notes remain unchanged.' };
	}
	if (item.status === 'success' && item.assets?.failed) return {
		code: 'review-assets', message: 'Markdown was saved, but some images remain remote/unresolved. Inspect assets.items in the report; offline reading is incomplete. Retry intentionally with --download-assets --overwrite after resolving image access or network failures.',
	};
	if (item.status === 'success') return {
		code: 'review-markdown', message: 'Review the Markdown sections, formulas, tables and figure captions. Basic checks do not prove full-text completeness.',
	};
	if (item.status === 'skipped') return {
		code: 'review-existing', message: 'Existing Markdown was not revalidated or changed. Use --overwrite only to intentionally reprocess it.',
	};
	if (item.accessLimited || item.quality?.reasons.some(reason => ['subscription-preview', 'access-challenge'].includes(reason))) return {
		code: 'export-authorized-tab',
		message: 'Open the paper in a browser where you are authorized to read the full text. Confirm Results/Methods are loaded, use Clipper Export page HTML, keep the HTML/JSON pair together, then run npm run clip -- "<export-folder>". Export cannot grant access or recover unloaded content.',
	};
	if (item.status === 'incomplete') return {
		code: item.quality?.reasons.includes('unrendered-equations') ? 'render-equations' : 'inspect-content',
		message: item.quality?.reasons.includes('unrendered-equations')
			? 'Equation links point to missing equation elements. Allow browser rendering (omit --fetch http), or export a fresh authorized tab after formulas have loaded; then import the HTML/JSON pair.'
			: 'Inspect the retained capture and failed content checks. If the authorized browser shows missing sections, export a fresh HTML/JSON pair and import it. Do not assume a preview is full text.',
	};
	if (route === 'import' && /companion JSON|schemaVersion|htmlBytes|HTML size mismatch|UTF-8|Missing HTML file|capturedAt|Captured URL/i.test(item.error ?? '')) return {
		code: 'repair-export-pair', message: 'Keep the original .html and .html.json downloads together with matching names. Re-export if either file is missing, renamed, invalid, or incomplete.',
	};
	return { code: 'inspect-error', message: 'Inspect the error and retained report. Check the input, output path, template and CLI build; retry after correcting the cause.' };
}

async function archiveResults(options, report) {
	const summary = report.archive = {
		vault: options.archive.vault, papersDir: options.archive.papersDir,
		counts: { archived: 0, duplicate: 0, blocked: 0, failed: 0 },
	};
	const eligible = [];
	for (const item of report.items) {
		if (!['success', 'skipped'].includes(item.status) || !item.output) {
			item.archive = { status: 'blocked', reason: 'conversion-not-accepted' };
		} else if (item.assets?.failed || item.assets?.status === 'partial') {
			item.archive = { status: 'blocked', reason: 'incomplete-assets' };
		} else eligible.push(item);
	}
	if (eligible.length) {
		try {
			const result = await archivePapers({ ...options.archive, inputs: eligible.map(item => item.output),
				expectedSources: Object.fromEntries(eligible.map(item => [item.output, item.url])),
				checks: { minWords: options.config.minWords, requiredSections: options.config.requiredSections, expectedDoi: options.config.expectedDoi } });
			summary.reportPath = result.reportPath;
			const byInput = new Map(result.report.items.map(item => [item.input, item]));
			for (const item of eligible) {
				item.archive = byInput.get(item.output) ?? { status: 'failed', error: 'Archive stage returned no result for this paper.' };
				if (result.reportPath) item.archive.reportPath = result.reportPath;
			}
		} catch (error) {
			summary.error = error.message;
			for (const item of eligible) item.archive = { status: 'failed', error: error.message };
		}
	}
	for (const item of report.items) summary.counts[item.archive.status]++;
	return summary.counts.failed > 0 || report.items.some(item => item.archive.reason === 'incomplete-assets');
}

async function captureUrl(options) {
	const item = { input: options.input, url: options.input, output: options.config.output, status: 'failed', outputWritten: false };
	try {
		let existing;
		try { existing = await lstat(item.output); }
		catch (error) { if (error.code !== 'ENOENT') throw error; }
		if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Output destination is not a regular file; refusing to replace it.');
		if (existing && !options.config.overwrite) {
			item.status = 'skipped';
			item.reason = 'output-exists';
			return { exitCode: 0, item };
		}
		const { exitCode, report } = await clipPaper(options.config);
		const attempt = report.attempts.findLast(attempt => attempt.quality);
		Object.assign(item, {
			status: exitCode === 0 ? 'success' : exitCode === 2 ? 'incomplete' : 'failed',
			outputWritten: report.outputWritten, url: report.url ?? options.input,
			paperReport: path.join(report.artifactDirectory, 'report.json'), artifactDirectory: report.artifactDirectory,
		});
		if (report.assets) item.assets = report.assets;
		if (attempt) {
			item.title = attempt.title;
			item.quality = attempt.quality;
			if (attempt.normalizations) item.normalizations = attempt.normalizations;
		}
		const error = report.error ?? report.attempts.at(-1)?.error;
		if (error) item.error = error;
		if (item.status !== 'success') item.accessLimited = report.attempts.some(attempt =>
			/\bHTTP (?:401|403)\b/.test(attempt.error ?? '') ||
			attempt.quality?.reasons.some(reason => ['subscription-preview', 'access-challenge'].includes(reason)));
		return { exitCode, item };
	} catch (error) {
		item.error = error.message;
		return { exitCode: 1, item };
	}
}

export async function clip(options) {
	if (options.archive) await validateVaultDestination(options.archive, [options.outputDir]);
	const runs = path.join(options.outputDir, '_clips');
	await mkdir(runs, { recursive: true });
	const directory = await mkdtemp(path.join(runs, 'run-'));
	const reportPath = path.join(directory, 'report.json');
	const report = {
		schemaVersion: 1, route: options.route, input: options.input, outputDir: options.outputDir,
		startedAt: new Date().toISOString(), status: 'running',
		counts: { success: 0, incomplete: 0, failed: 0, skipped: 0 }, items: [],
	};
	await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
	let exitCode;
	try {
		if (options.route === 'url') {
			const result = await captureUrl(options);
			exitCode = result.exitCode;
			report.items.push(result.item);
		} else {
			const result = await importPapers(options.config, { log: () => {} });
			exitCode = result.exitCode;
			report.items = result.report.items;
			report.sourceReport = result.reportPath;
			if (result.report.error) report.error = result.report.error;
		}
	} catch (error) {
		exitCode = 1;
		report.items.push({ input: options.input, status: 'failed', outputWritten: false, error: error.message });
	}
	if (options.archive) {
		report.phase = 'archiving';
		await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
		if (await archiveResults(options, report)) exitCode = 1;
		report.phase = 'finished';
	}
	for (const item of report.items) {
		item.nextStep = nextStep(item, options.route);
		report.counts[item.status]++;
	}
	if (!report.items.length) report.nextStep = {
		code: 'provide-export-pairs', message: 'Place exported .html and .html.json pairs at the top level of the input directory, then run the same command again.',
	};

	report.exitCode = exitCode;
	report.status = !report.items.length ? 'empty' : exitCode ? 'completed-with-issues' : 'completed';
	report.finishedAt = new Date().toISOString();
	await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
	return { exitCode, report, reportPath };
}

export function printResult({ report, reportPath }, log = console.log) {
	for (const item of report.items) {
		log(`[${item.status}] ${item.title || item.input}`);
		if (item.output) log(`  ${item.outputWritten ? 'Markdown' : 'Destination (not written)'}: ${item.output}`);
		if (item.error) log(`  Error: ${item.error}`);
		if (item.quality?.reasons.length) log(`  Checks: ${item.quality.reasons.join(', ')}`);
		const captionChecks = [item.quality?.figureCaptions, item.quality?.outputFigureCaptions,
			item.archive?.figureCaptions, item.archive?.quality?.figureCaptions].filter(Boolean);
		for (const check of [...new Set(captionChecks)]) {
			log(`  Figure legends: ${check.status}${check.reason ? ` (${check.reason})` : ` (${check.matched}/${check.expected} matched)`}.`);
			for (const figure of check.figures.filter(figure => !figure.passed)) log(`    ${figure.title || figure.id || 'Unknown figure'}: ${figure.errors.join('; ')}`);
			if (check.error) log(`    ${check.error}`);
		}
		if (item.paperReport) log(`  Details: ${item.paperReport}`);
		if (item.assets) log(`  Images: ${item.assets.downloaded} downloaded, ${item.assets.failed} unresolved (${item.assets.status}).`);
		if (item.archive) {
			log(`  Vault: ${item.archive.status}${item.archive.reason ? ` (${item.archive.reason})` : ''}`);
			if (item.archive.output) log(`  Vault note: ${item.archive.output}`);
			if (item.archive.error) log(`  Archive error: ${item.archive.error}`);
			if (item.archive.quality?.reasons.length) log(`  Archive checks: ${item.archive.quality.reasons.join(', ')}`);
		}
		log(`  Next: ${item.nextStep.message}`);
	}
	if (report.error) log(`Error: ${report.error}`);
	if (report.nextStep) log(`Next: ${report.nextStep.message}`);
	log(`Summary: ${Object.entries(report.counts).map(([status, count]) => `${status}=${count}`).join(', ')}`);
	if (report.archive) {
		log(`Vault summary: ${Object.entries(report.archive.counts).map(([status, count]) => `${status}=${count}`).join(', ')}`);
		log(`Vault directory: ${report.archive.vault}`);
		if (report.archive.reportPath) log(`Archive report: ${report.archive.reportPath}`);
	}
	log(`Output directory: ${report.outputDir}\nReport: ${reportPath}`);
}

export async function main(args = process.argv.slice(2)) {
	const options = parseOptions(args);
	if (options.help) { console.log(usage); return 0; }
	const result = await clip(options);
	printResult(result);
	return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(code => { process.exitCode = code; }).catch(error => {
		console.error(`[failed] ${error.message ?? error}\nRun npm run clip -- --help for usage.`);
		process.exitCode = 1;
	});
}
