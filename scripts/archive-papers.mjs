import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseDocument, stringify } from 'yaml';
import { collectImages, imageExtension } from './paper-assets.mjs';
import { canonicalUrl, normalizeDoi, paperMetadata } from './paper-metadata.mjs';
import { archiveRequirements, assessPaper, inspectHtml, qualitySummary, withOutputQuality } from './paper-validation.mjs';

const maxDocument = 30 * 1024 * 1024;
const usage = `Usage: npm run clip:vault -- <paper.md | directory> [...] --vault <directory> [options]

Archive accepted paper outputs and their local images, without any network access.
Inputs require the matching <paper.md>.report.json and retained conversion files.
Directories are scanned only at the top level for those report/Markdown pairs.

  --vault <directory>      Vault root (required; created only during a real run)
  --papers-dir <relative>  Paper folder within the Vault (default: Papers)
  --dry-run               Read/check/plan only; creates no files or directories
  --json                  Print the full result as JSON
  -h, --help              Show help

Duplicates are skipped by DOI, then canonical source URL. Conflicts fail visibly.
Existing notes, annotations and attachments are never overwritten or deleted.
Partial/remote image sets are rejected; run clip --download-assets first.
Exit: 0 archived/planned/duplicate only, 1 conflict/failure/empty input.
`;

function within(root, target) {
	const relative = path.relative(root, target);
	return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function archiveError(code, message, details = {}) {
	return Object.assign(new Error(message), { code, ...details });
}

export async function validateVaultDestination(options, sourceDirectories = []) {
	if (!within(options.vault, options.papersDir) || options.papersDir === options.vault) throw new Error('Paper folder must be strictly inside the Vault.');
	await plainDirectories(options.vault);
	await plainDirectories(options.papersDir);
	await plainDirectories(path.join(options.vault, '.paper-clipper'));
	for (const directory of sourceDirectories) {
		if (within(options.vault, directory)) throw new Error('Conversion output must be outside the destination Vault.');
		await plainDirectories(directory);
	}
}

async function info(file) {
	try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function plainDirectories(directory) {
	const absolute = path.resolve(directory);
	const { root } = path.parse(absolute);
	let current = root;
	for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		const entry = await info(current);
		if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error(`Directory is not a plain directory: ${current}`);
	}
}

async function regularBytes(file, limit = maxDocument) {
	await plainDirectories(path.dirname(file));
	const entry = await lstat(file);
	if (!entry.isFile() || entry.isSymbolicLink() || entry.size > limit) throw new Error(`Expected a bounded regular file: ${file}`);
	const bytes = await readFile(file);
	if (bytes.length > limit) throw new Error(`File exceeds size limit: ${file}`);
	return bytes;
}

async function jsonFile(file, limit = 2 * 1024 * 1024) {
	return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await regularBytes(file, limit)));
}

export function splitFrontmatter(markdown) {
	const match = markdown.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) return { properties: {}, body: markdown };
	const document = parseDocument(match[1], { uniqueKeys: true });
	if (document.errors.length) throw new Error(`Invalid YAML frontmatter: ${document.errors[0].message}`);
	const properties = document.toJS({ maxAliasCount: 20 }) ?? {};
	if (typeof properties !== 'object' || Array.isArray(properties)) throw new Error('Frontmatter must be a YAML mapping.');
	return { properties, body: markdown.slice(match[0].length) };
}

export function parseOptions(args) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
		vault: { type: 'string' }, 'papers-dir': { type: 'string', default: 'Papers' },
		'dry-run': { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
	} });
	if (values.help) return { help: true };
	if (!positionals.length || positionals.some(value => !value.trim()) || !values.vault?.trim()) throw new Error('Provide input papers/directories and --vault.');
	const subdir = values['papers-dir'];
	if (!subdir.trim() || path.isAbsolute(subdir) || subdir.split(/[\\/]/).some(part => !part || ['.', '..'].includes(part) || part.startsWith('.') || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) throw new Error('--papers-dir must be a safe relative directory, without traversal or hidden components.');
	const vault = path.resolve(values.vault);
	return { inputs: positionals.map(value => path.resolve(value)), vault, papersDir: path.resolve(vault, subdir), dryRun: values['dry-run'], json: values.json };
}

async function inputsIn(paths) {
	const papers = new Set();
	for (const input of paths) {
		await plainDirectories(path.dirname(input));
		const entry = await lstat(input);
		if (entry.isSymbolicLink()) throw new Error('Input links are not supported.');
		if (entry.isFile() && /\.md$/i.test(input)) papers.add(input);
		else if (entry.isDirectory()) {
			for (const file of await readdir(input, { withFileTypes: true })) {
				if (file.isFile() && /\.md\.report\.json$/i.test(file.name)) papers.add(path.join(input, file.name.slice(0, -12)));
			}
		} else throw new Error('Input must be a Markdown file or a directory of accepted papers.');
	}
	return [...papers].sort();
}

async function existingNotes(vault) {
	const notes = [];
	let scanned = 0;
	const scan = async (directory, depth) => {
		if (depth > 32) throw new Error('Vault scan exceeded 32 directory levels.');
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name.startsWith('.')) continue;
			const file = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Vault contains an unsupported link: ${file}`);
			if (entry.isDirectory()) await scan(file, depth + 1);
			else if (entry.isFile() && /\.md$/i.test(entry.name)) {
				if (++scanned > 5000) throw new Error('Vault scan exceeded 5000 Markdown files.');
				const { properties } = splitFrontmatter(new TextDecoder('utf-8', { fatal: true }).decode(await regularBytes(file)));
				if (!properties.doi && !properties.source && !properties.url) continue;
				const doi = properties.doi ? normalizeDoi(properties.doi) : null;
				const sources = [...new Set([properties.source, properties.url].filter(Boolean).map(canonicalUrl))];
				notes.push({ file, doi, sources, title: properties.title });
			}
		}
	};
	if (await info(vault)) await scan(vault, 0);
	return notes;
}

function duplicate(metadata, notes) {
	const sameUrl = notes.filter(note => note.sources.includes(metadata.source));
	if (sameUrl.some(note => note.doi && metadata.doi && note.doi !== metadata.doi)) throw new Error('Canonical URL is already associated with a different DOI.');
	const sameDoi = metadata.doi ? notes.filter(note => note.doi === metadata.doi) : [];
	const matches = [...new Map([...sameDoi, ...sameUrl].map(note => [note.file, note])).values()];
	if (matches.length > 1) throw new Error('Identity matches multiple existing notes; resolve duplicates manually.');
	return matches[0];
}

function filename(metadata) {
	const title = metadata.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 85).replace(/[. ]+$/, '') || 'Paper';
	return `${metadata.year ?? 'undated'} ${title}.md`;
}

async function prepare(input, options) {
	const bytes = await regularBytes(input);
	const markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	const reportPath = `${input}.report.json`;
	const report = await jsonFile(reportPath);
	if (report.status !== 'passed-checks' || !report.outputWritten || path.resolve(report.output ?? '') !== input) throw new Error('Input is not the accepted output named in its paper report.');
	const artifacts = path.resolve(report.artifactDirectory ?? '');
	if (!within(`${input}.runs`, artifacts) || artifacts === `${input}.runs`) throw new Error('Conversion artifact directory escapes this paper.');
	if (!(await regularBytes(path.join(artifacts, 'accepted.md'))).equals(bytes)) throw new Error('Markdown differs from its accepted snapshot; refusing to archive an unverified edit.');
	const attempt = report.attempts?.findLast(item => item.status === 'passed-checks' && item.quality?.passed);
	if (!attempt?.html || !within(artifacts, path.resolve(attempt.html))) throw new Error('No bounded successful source capture.');
	const expectedSource = options.expectedSources?.[input];
	if (expectedSource) {
		const knownSources = [report.requestedUrl, report.contentUrl, report.url, attempt.url, attempt.contentUrl].filter(Boolean).map(canonicalUrl);
		if (!knownSources.includes(canonicalUrl(expectedSource))) throw archiveError('source-mismatch', 'Saved output belongs to a different source URL. Choose a new conversion output location or intentionally reconvert it.');
	}
	const html = new TextDecoder('utf-8', { fatal: true }).decode(await regularBytes(attempt.html));
	const sourceUrl = attempt.contentUrl || report.contentUrl || report.url;
	const requirements = archiveRequirements(report.checks, options.checks);
	const page = inspectHtml(html, sourceUrl);
	page.preview ||= attempt.capture?.status === 'subscription-preview';
	const requirePassing = (quality, stage) => {
		if (quality.passed) return;
		const code = ['paper-identity', 'figure-captions', 'source-sections'].find(reason => quality.reasons.includes(reason)) ?? 'content-check';
		throw archiveError(code, `Saved ${stage} does not pass current checks. Inspect the retained source and quality diagnostics before reconverting.`, { quality, stage });
	};
	// Recheck both artifacts even for legacy reports and standalone/dry-run calls.
	// A prior passing flag never certifies the source, extraction or final template.
	const outputQuality = assessPaper(html, markdown, sourceUrl, requirements, page);
	requirePassing(outputQuality, 'output');
	if (!attempt.markdown || !within(artifacts, path.resolve(attempt.markdown))) throw new Error('No bounded extracted Markdown for current content checks.');
	const extracted = new TextDecoder('utf-8', { fatal: true }).decode(await regularBytes(attempt.markdown));
	const extractionQuality = assessPaper(html, extracted, sourceUrl, requirements, page);
	requirePassing(extractionQuality, 'extraction');
	const quality = withOutputQuality(extractionQuality, outputQuality);
	const { figureCaptions, sourceSections, paperIdentity } = outputQuality;
	const metadata = paperMetadata(html, { url: sourceUrl,
		capturedAt: report.capturedAt || attempt.capture?.capturedAt, convertedAt: report.finishedAt });
	const { properties, body } = splitFrontmatter(markdown);
	if (properties.doi && normalizeDoi(properties.doi) !== metadata.doi) throw new Error('Markdown DOI conflicts with captured article metadata.');
	if (properties.source && canonicalUrl(properties.source) !== metadata.source) throw new Error('Markdown source conflicts with captured article metadata.');
	const images = collectImages(markdown);
	if (images.length && (!report.assets || report.assets.status !== 'complete' || report.assets.failed)) throw archiveError('incomplete-assets', 'Paper has unresolved images. Convert with --download-assets before archiving.');
	const attachments = [];
	const seen = new Set();
	let size = 0;
	for (const image of images) {
		if (!image.url || /^[a-z][a-z0-9+.-]*:|^[/\\]|[?#]/i.test(image.url)) throw archiveError('incomplete-assets', 'Image must use a local relative path.');
		const relative = decodeURIComponent(image.url);
		const source = path.resolve(path.dirname(input), relative);
		if (!within(path.dirname(input), source) || relative.split(/[\\/]/).includes('..')) throw new Error('Image path escapes the paper directory.');
		const asset = report.assets.items.find(item => item.status === 'downloaded' && item.relativePath === image.url && path.resolve(item.file) === source);
		if (!asset) throw new Error('Image is not a recorded downloaded attachment.');
		if (seen.has(source)) continue;
		seen.add(source);
		const content = await regularBytes(source, 20 * 1024 * 1024);
		if (content.length !== asset.bytes) throw new Error('Attachment size differs from the conversion report.');
		imageExtension(content, asset.contentType);
		size += content.length;
		if (size > 100 * 1024 * 1024 || attachments.length >= 200) throw new Error('Attachment set exceeds archive limits.');
		attachments.push({ source, relative, content });
	}
	// Hashing here names the DOI/URL identity, not the paper or its attachments.
	const id = createHash('sha256').update(metadata.identity).digest('hex').slice(0, 16);
	const merged = { ...properties, ...metadata, paper_clipper_id: id, archive_status: 'clipped-source' };
	return { input, reportPath, metadata, figureCaptions, sourceSections, paperIdentity, quality, requirements, id, name: filename(metadata), attachments, originalBytes: bytes,
		markdown: `---\n${stringify(merged, { lineWidth: 0 })}---\n${body}` };
}

export async function archivePapers(options) {
	await validateVaultDestination(options);
	const inputs = await inputsIn(options.inputs);
	if (inputs.some(input => within(options.vault, input))) throw new Error('Source papers must be outside the destination Vault.');
	const stateDir = path.join(options.vault, '.paper-clipper');
	await plainDirectories(stateDir);
	const report = { schemaVersion: 1, dryRun: options.dryRun, vault: options.vault, papersDir: options.papersDir,
		startedAt: new Date().toISOString(), counts: { planned: 0, archived: 0, duplicate: 0, failed: 0 }, items: [] };
	let lock;
	let reportPath;
	const lockPath = path.join(stateDir, 'archive.lock');
	try {
		if (!options.dryRun) {
			await mkdir(stateDir, { recursive: true });
			try { lock = await open(lockPath, 'wx'); } catch (error) {
				if (error.code === 'EEXIST') throw new Error('Vault archive lock exists. Another import may be running; inspect before manually removing the single stale lock file.');
				throw error;
			}
			await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: report.startedAt }));
			await plainDirectories(path.join(stateDir, 'runs'));
			await mkdir(path.join(stateDir, 'runs'), { recursive: true });
			reportPath = path.join(await mkdtemp(path.join(stateDir, 'runs', 'run-')), 'report.json');
		}
		const notes = await existingNotes(options.vault);
		for (const input of inputs) {
			const item = { input, status: 'failed' };
			try {
				const paper = await prepare(input, options);
				item.metadata = paper.metadata;
				item.figureCaptions = paper.figureCaptions;
				item.sourceSections = paper.sourceSections;
				item.quality = paper.quality;
				item.checks = paper.requirements;
				if (paper.paperIdentity) item.paperIdentity = paper.paperIdentity;
				item.attachments = paper.attachments.length;
				const found = duplicate(paper.metadata, notes);
				if (found) {
					item.status = 'duplicate'; item.output = found.file;
				} else {
					const destination = path.join(options.papersDir, `p-${paper.id}`);
					item.output = path.join(destination, paper.name);
					if (await info(destination)) throw new Error('Destination already exists without a matching note; refusing to replace it.');
					if (!options.dryRun) {
						await plainDirectories(options.papersDir);
						await mkdir(options.papersDir, { recursive: true });
						await plainDirectories(path.join(stateDir, 'staging'));
						await mkdir(path.join(stateDir, 'staging'), { recursive: true });
						const staging = await mkdtemp(path.join(stateDir, 'staging', 'paper-'));
						item.staging = staging;
						for (const attachment of paper.attachments) {
							const target = path.resolve(staging, attachment.relative);
							if (!within(staging, target)) throw new Error('Attachment escapes staging directory.');
							await mkdir(path.dirname(target), { recursive: true });
							await writeFile(target, attachment.content, { flag: 'wx' });
						}
						await writeFile(path.join(staging, paper.name), paper.markdown, { flag: 'wx' });
						await writeFile(path.join(staging, 'paper.json'), JSON.stringify({ schemaVersion: 1, metadata: paper.metadata,
							quality: paper.quality, checks: paper.requirements,
							originalInput: input, originalReport: paper.reportPath, archivedAt: new Date().toISOString(),
							note: paper.name, attachments: paper.attachments.map(asset => ({ relativePath: asset.relative, bytes: asset.content.length })) }, null, 2) + '\n', { flag: 'wx' });
						if (await info(destination)) throw new Error('Destination appeared during archiving; refusing to replace it.');
						await rename(staging, destination);
						delete item.staging;
					}
					item.status = options.dryRun ? 'planned' : 'archived';
					notes.push({ file: item.output, doi: paper.metadata.doi, sources: [paper.metadata.source], title: paper.metadata.title });
				}
			} catch (error) {
				item.error = error.message;
				if (error.code) item.code = error.code;
				if (error.quality) item.quality = error.quality;
				if (error.stage) item.stage = error.stage;
			}
			report.items.push(item);
			report.counts[item.status]++;
			if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
		}
		if (!inputs.length) report.error = 'No paper report/Markdown pairs found at the top level.';
		report.exitCode = report.error || report.counts.failed ? 1 : 0;
		report.finishedAt = new Date().toISOString();
		if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
		return { exitCode: report.exitCode, report, reportPath };
	} finally {
		if (lock) {
			await lock.close();
			// Delete only this invocation's one explicitly owned lock file.
			await unlink(lockPath);
		}
	}
}

export async function main(args = process.argv.slice(2)) {
	const options = parseOptions(args);
	if (options.help) { console.log(usage); return 0; }
	const result = await archivePapers(options);
	if (options.json) console.log(JSON.stringify(result, null, 2));
	else {
		for (const item of result.report.items) {
			console.log(`[${item.status}] ${item.metadata?.title || item.input}`);
			if (item.output) console.log(`  ${item.output}`);
			if (item.error) console.log(`  ${item.error}`);
			console.log(`  ${qualitySummary(item.quality)}`);
			if (item.metadata?.metadata_gaps.length) console.log(`  Metadata gaps: ${item.metadata.metadata_gaps.join(', ')}`);
		}
		console.log(`Summary: ${Object.entries(result.report.counts).map(([key, value]) => `${key}=${value}`).join(', ')}`);
		if (result.report.error) console.log(result.report.error);
		if (result.reportPath) console.log(`Report: ${result.reportPath}`);
		if (options.dryRun) console.log('Dry run only: no files or directories were created.');
	}
	return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
