import { access, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { clipPaper, parseOptions as parsePaperOptions } from './clip-paper.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const maxHtmlBytes = 30 * 1024 * 1024;
const maxMetadataBytes = 64 * 1024;
const usage = `Usage: node scripts/import-papers.mjs <file.html | directory> [options]

Import Clipper HTML/JSON export pairs. Offline unless --download-assets is set.
Directory scans are not recursive.

  -o, --output-dir <path>    Output directory (default: output/browser-fetch/imported)
  -t, --template <path>      Optional Clipper template JSON or directory
      --min-words <count>    Minimum body words before References (default: 1000)
      --require-section <h>  Required level-2 heading; repeat as needed
      --timeout <ms>         Timeout per conversion (default: 60000)
      --overwrite            Replace existing Markdown only after checks pass
      --download-assets      Download image attachments without browser credentials
  -h, --help                 Show this help

Requires each HTML's companion <file.html>.json from the Clipper export button.
Preserves inputs. Existing outputs are skipped unless --overwrite is supplied.
Writes a unique _imports/run-*/report.json with success/incomplete/failed/skipped
entries and immutable input copies for attempted conversions.
Exit: 0 all successful/skipped, 1 failures or empty input, 2 incomplete only.
`;

function positiveInteger(value, flag, maximum = Number.MAX_SAFE_INTEGER) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${flag} must be a positive integer up to ${maximum}.`);
	return parsed;
}

export function parseOptions(args) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
		'output-dir': { type: 'string', short: 'o' },
		template: { type: 'string', short: 't' },
		'min-words': { type: 'string', default: '1000' },
		'require-section': { type: 'string', multiple: true, default: [] },
		timeout: { type: 'string', default: '60000' },
		overwrite: { type: 'boolean', default: false },
		'download-assets': { type: 'boolean', default: false },
		help: { type: 'boolean', short: 'h' },
	} });
	if (values.help) return { help: true };
	if (positionals.length !== 1 || !positionals[0].trim()) throw new Error('Provide one HTML file or directory.');
	if (values['output-dir'] !== undefined && !values['output-dir'].trim()) throw new Error('--output-dir cannot be empty.');
	if (values.template !== undefined && !values.template.trim()) throw new Error('--template cannot be empty.');
	const requiredSections = values['require-section'].map(value => value.trim());
	if (requiredSections.some(value => !value)) throw new Error('--require-section cannot be empty.');
	return {
		input: path.resolve(positionals[0]),
		outputDir: path.resolve(values['output-dir'] ?? path.join(root, 'output/browser-fetch/imported')),
		template: values.template ? path.resolve(values.template) : undefined,
		minWords: positiveInteger(values['min-words'], '--min-words'),
		timeout: positiveInteger(values.timeout, '--timeout', 2147483647),
		requiredSections,
		overwrite: values.overwrite, downloadAssets: values['download-assets'],
	};
}

async function discoverInputs(input) {
	const info = await lstat(input);
	if (info.isSymbolicLink()) throw new Error('Symbolic links are not supported as import inputs.');
	if (info.isFile()) {
		if (!/\.html$/i.test(input)) throw new Error('The input file must end in .html.');
		return [input];
	}
	if (!info.isDirectory()) throw new Error('The input must be a regular HTML file or directory.');
	const files = new Set();
	for (const entry of await readdir(input, { withFileTypes: true })) {
		if (entry.isDirectory()) continue;
		if (/\.html$/i.test(entry.name)) files.add(path.join(input, entry.name));
		// Include orphaned sidecars so interrupted downloads are reported, not ignored.
		else if (/\.html\.json$/i.test(entry.name)) files.add(path.join(input, entry.name.slice(0, -5)));
	}
	return [...files].sort();
}

async function readRegularFile(file, limit, label) {
	let info;
	try { info = await lstat(file); }
	catch (error) {
		if (error.code === 'ENOENT') throw new Error(`Missing ${label}: ${file}`);
		throw error;
	}
	if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file, not a link: ${file}`);
	if (info.size > limit) throw new Error(`${label} exceeds the ${limit} byte limit.`);
	const buffer = await readFile(file);
	if (buffer.length > limit) throw new Error(`${label} exceeds the ${limit} byte limit.`);
	return buffer;
}

function utf8(buffer, label) {
	try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
	catch { throw new Error(`${label} is not valid UTF-8.`); }
}

export async function readExportPair(htmlPath) {
	const metadataPath = `${htmlPath}.json`;
	const metadataBytes = await readRegularFile(metadataPath, maxMetadataBytes, 'companion JSON');
	let metadata;
	try { metadata = JSON.parse(utf8(metadataBytes, 'Companion JSON')); }
	catch (error) { throw new Error(`Invalid companion JSON: ${error.message}`); }
	if (!metadata || Array.isArray(metadata) || metadata.schemaVersion !== 1 || metadata.captureMethod !== 'clipper-dom') {
		throw new Error('Expected schemaVersion 1 metadata with captureMethod "clipper-dom".');
	}
	if (typeof metadata.url !== 'string') throw new Error('Companion JSON must include the captured page URL in "url".');
	let url;
	try { url = new URL(metadata.url); }
	catch { throw new Error('Companion JSON has an invalid page URL.'); }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new Error('Captured URL must use HTTP(S) without embedded credentials.');
	}
	if (typeof metadata.title !== 'string' || typeof metadata.capturedAt !== 'string' || !Number.isFinite(Date.parse(metadata.capturedAt))) {
		throw new Error('Companion JSON must include a title and valid capturedAt timestamp.');
	}
	if (metadata.charset !== 'UTF-8') throw new Error('Only UTF-8 exports are supported.');
	// Never use a path from metadata to locate an input or name an output.
	if (metadata.htmlFile !== path.basename(htmlPath)) {
		throw new Error('Companion JSON htmlFile does not match the HTML filename. Keep the original export pair names together.');
	}
	if (!Number.isSafeInteger(metadata.htmlBytes) || metadata.htmlBytes < 1 || metadata.htmlBytes > maxHtmlBytes) {
		throw new Error('Companion JSON htmlBytes must be between 1 byte and 30 MiB.');
	}
	const html = await readRegularFile(htmlPath, maxHtmlBytes, 'HTML file');
	if (html.length !== metadata.htmlBytes) throw new Error(`HTML size mismatch: metadata says ${metadata.htmlBytes} bytes; file has ${html.length}.`);
	utf8(html, 'HTML file');
	return { html, metadataBytes, metadata, url: url.href };
}

async function inspectOutput(output) {
	try { return await lstat(output); }
	catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function importPapers(options, { log = console.log } = {}) {
	const inputs = await discoverInputs(options.input);
	await access(path.join(root, 'dist/cli.cjs')).catch(() => { throw new Error('Build the Clipper CLI first: npm run build:cli'); });
	if (options.template) {
		const info = await lstat(options.template);
		if (info.isFile()) JSON.parse(await readFile(options.template, 'utf8'));
		else if (!info.isDirectory()) throw new Error('Template must be a JSON file or directory.');
	}
	await mkdir(path.join(options.outputDir, '_imports'), { recursive: true });
	const directory = await mkdtemp(path.join(options.outputDir, '_imports', 'run-'));
	const reportPath = path.join(directory, 'report.json');
	const report = {
		schemaVersion: 1, input: options.input, outputDir: options.outputDir,
		startedAt: new Date().toISOString(), status: 'running', discovered: inputs.length,
		options: { overwrite: options.overwrite, downloadAssets: Boolean(options.downloadAssets), minWords: options.minWords, requiredSections: options.requiredSections, timeout: options.timeout, template: options.template ?? 'minimal' },
		counts: { success: 0, incomplete: 0, failed: 0, skipped: 0 }, items: [],
	};
	const persist = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
	await persist();
	for (const input of inputs) {
		const output = path.join(options.outputDir, `${path.basename(input, path.extname(input))}.md`);
		const item = { input, metadata: `${input}.json`, output, status: 'failed', outputWritten: false };
		try {
			const pair = await readExportPair(input);
			Object.assign(item, { title: pair.metadata.title, url: pair.url, capturedAt: pair.metadata.capturedAt, htmlBytes: pair.html.length });
			const existing = await inspectOutput(output);
			if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Output destination is not a regular file; refusing to replace it.');
			if (existing && !options.overwrite) {
				item.status = 'skipped';
				item.reason = 'output-exists';
			} else {
				const snapshotDir = path.join(directory, `item-${String(report.items.length + 1).padStart(4, '0')}`);
				await mkdir(snapshotDir);
				item.snapshotHtml = path.join(snapshotDir, path.basename(input));
				// Convert the validated bytes, even if the original download changes later.
				await writeFile(item.snapshotHtml, pair.html);
				await writeFile(`${item.snapshotHtml}.json`, pair.metadataBytes);
				const args = [pair.url, '--html', item.snapshotHtml, '-o', output, '--min-words', String(options.minWords)];
				for (const heading of options.requiredSections) args.push('--require-section', heading);
				if (options.template) args.push('--template', options.template);
				if (options.overwrite) args.push('--overwrite');
				if (options.downloadAssets) args.push('--download-assets');
				const config = { ...parsePaperOptions(args), timeout: options.timeout, capturedAt: pair.metadata.capturedAt, expectedDoi: options.expectedDoi };
				const result = await clipPaper(config);
				item.status = result.exitCode === 0 ? 'success' : result.exitCode === 2 ? 'incomplete' : 'failed';
				item.outputWritten = result.report.outputWritten;
				item.paperReport = path.join(result.report.artifactDirectory, 'report.json');
				item.artifactDirectory = result.report.artifactDirectory;
				if (result.report.assets) item.assets = result.report.assets;
				const attempt = result.report.attempts[0];
				if (attempt?.quality) item.quality = attempt.quality;
				if (attempt?.normalizations) item.normalizations = attempt.normalizations;
				if (result.report.error || attempt?.error) item.error = result.report.error ?? attempt.error;
			}
		} catch (error) {
			item.status = 'failed';
			item.error = error.message;
		}
		report.items.push(item);
		report.counts[item.status]++;
		await persist();
		log(`[${item.status}] ${path.basename(input)}`);
		if (item.error) log(`  ${item.error}`);
		if (item.status === 'incomplete') log(`  ${item.quality?.reasons.join(', ') || 'Content checks failed.'}`);
		if (item.assets) log(`  Images: ${item.assets.downloaded} downloaded, ${item.assets.failed} unresolved.${item.assets.failed ? ' Not fully offline; see the report.' : ''}`);
	}
	const exitCode = !inputs.length || report.counts.failed ? 1 : report.counts.incomplete ? 2 : 0;
	report.status = !inputs.length ? 'empty' : exitCode ? 'completed-with-issues' : 'completed';
	if (!inputs.length) report.error = 'No HTML exports found. Directory scanning is not recursive.';
	report.exitCode = exitCode;
	report.finishedAt = new Date().toISOString();
	await persist();
	return { exitCode, report, reportPath };
}

export async function main(args = process.argv.slice(2)) {
	const options = parseOptions(args);
	if (options.help) { console.log(usage); return 0; }
	const { exitCode, report, reportPath } = await importPapers(options);
	console.log(`Summary: ${Object.entries(report.counts).map(([status, count]) => `${status}=${count}`).join(', ')}`);
	if (report.error) console.error(report.error);
	console.log(`Output directory: ${options.outputDir}\nBatch report: ${reportPath}`);
	return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(code => { process.exitCode = code; }).catch(error => {
		console.error(error.message ?? error);
		process.exitCode = 1;
	});
}
