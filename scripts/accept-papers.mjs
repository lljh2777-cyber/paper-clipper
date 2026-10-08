import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Marked } from 'marked';
import { parseHTML } from 'linkedom';
import { clipPaper, parseOptions as paperOptions } from './clip-paper.mjs';
import { clip, parseOptions as clipOptions } from './clip.mjs';
import { auditNatureLegends, compareWithoutAddedLegends } from './paper-captions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const marked = new Marked({ gfm: true });
const normalize = value => value.replace(/\s+/g, ' ').trim();
export const stripFrontmatter = value => value.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');

function markdownDocument(markdown) {
	// Parse only. Linkedom does not execute scripts or load linked resources.
	return parseHTML(`<html><body>${marked.parse(stripFrontmatter(markdown))}</body></html>`).document;
}

function tableSnapshot(table) {
	return [...table.querySelectorAll('tr')].map(row => [...row.children]
		.filter(cell => ['TD', 'TH'].includes(cell.tagName))
		.map(cell => ({ text: normalize(cell.textContent), colspan: cell.getAttribute('colspan') || '1', rowspan: cell.getAttribute('rowspan') || '1' })));
}

function missingOccurrences(expected, actual) {
	const counts = new Map();
	for (const value of actual) counts.set(value, (counts.get(value) ?? 0) + 1);
	return expected.filter(value => {
		if (!counts.get(value)) return true;
		counts.set(value, counts.get(value) - 1);
		return false;
	});
}

export function markdownMetrics(markdown) {
	const body = stripFrontmatter(markdown);
	const document = markdownDocument(body);
	const tables = [...document.querySelectorAll('table')];
	const mathText = marked.lexer(body).filter(token => token.type !== 'code').map(token => token.raw).join('');
	const math = [...mathText.matchAll(/(?<![\\$])\$\$([\s\S]*?)(?<!\\)\$\$|(?<![\\$])\$((?:\\.|[^$\\\n])+?)\$(?!\$)/g)];
	return {
		bodyWords: body.trim().split(/\s+/).filter(Boolean).length,
		headings: [...document.querySelectorAll('h2')].map(h => normalize(h.textContent)),
		mathExpressions: math.length, displayEquations: math.filter(match => match[1] !== undefined).length,
		images: document.querySelectorAll('img').length,
		tables: tables.length, tableCells: tables.reduce((sum, table) => sum + table.querySelectorAll('td, th').length, 0),
		footnoteDefinitions: [...body.matchAll(/^\[\^[^\]]+\]:/gm)].length,
		links: document.querySelectorAll('a[href]').length,
	};
}

function excludeSections(markdown, names) {
	const removed = [];
	let skipping = false;
	const kept = [];
	for (const token of marked.lexer(markdown)) {
		if (token.type === 'heading' && token.depth <= 2) {
			skipping = token.depth === 2 && names.includes(token.text);
			if (skipping) removed.push(token.text);
		}
		if (!skipping) kept.push(token.raw);
	}
	return { text: kept.join(''), removed };
}

export function compareReference(actual, reference, { comparison = 'exact', excludeReferenceSections = [], referenceReplacements = [], referenceMissingNatureLegends, sourceHtml, url } = {}) {
	if (!['exact', 'whitespace'].includes(comparison)) throw new Error('Unknown reference comparison mode.');
	let a = stripFrontmatter(actual);
	let sourceCaptionAdditions;
	if (referenceMissingNatureLegends) {
		if (!sourceHtml || !url) throw new Error('Source HTML and URL are required to review added legends.');
		const reviewed = compareWithoutAddedLegends(sourceHtml, actual, reference, url, referenceMissingNatureLegends);
		a = reviewed.body;
		sourceCaptionAdditions = reviewed.figures;
	}
	const b = stripFrontmatter(reference);
	const filtered = excludeReferenceSections.length ? excludeSections(b, excludeReferenceSections) : { text: b, removed: [] };
	const applied = [];
	for (const replacement of referenceReplacements) {
		if (!replacement.from || typeof replacement.to !== 'string' || !replacement.reason || filtered.text.split(replacement.from).length !== 2) {
			throw new Error('A reviewed reference replacement must match exactly once and include a reason.');
		}
		filtered.text = filtered.text.replace(replacement.from, () => replacement.to);
		applied.push(replacement.reason);
	}
	const left = comparison === 'whitespace' ? normalize(a) : a;
	const right = comparison === 'whitespace' ? normalize(filtered.text) : filtered.text;
	let firstDifference = 0;
	while (firstDifference < Math.min(left.length, right.length) && left[firstDifference] === right[firstDifference]) firstDifference++;
	return {
		passed: left === right, comparison, exactBeforeExclusions: stripFrontmatter(actual) === b,
		sourceCaptionAdditions,
		whitespaceBeforeExclusions: normalize(stripFrontmatter(actual)) === normalize(b), excludedReferenceSections: filtered.removed,
		reviewedReferenceReplacements: applied,
		actualCharacters: left.length, referenceCharacters: right.length,
		firstDifference: left === right ? null : firstDifference,
	};
}

export function auditSource(html, markdown, url, selectors = {}) {
	const source = parseHTML(html).document;
	const output = markdownDocument(markdown);
	const checks = [];
	for (const [kind, selector] of Object.entries(selectors)) {
		if (kind === 'natureLegends') {
			const audit = auditNatureLegends(html, markdown, url);
			checks.push({ kind, selector, expected: audit.expected, missing: audit.missing, passed: audit.passed, figures: audit.figures });
			continue;
		}
		const elements = [...source.querySelectorAll(selector)].filter(element => kind !== 'captions' || element.textContent.trim());
		let missing = [];
		if (kind === 'tables') {
			const found = [...output.querySelectorAll('table')].map(table => JSON.stringify(tableSnapshot(table)));
			missing = missingOccurrences(elements.map(table => JSON.stringify(tableSnapshot(table))), found);
		} else if (kind === 'captions') {
			const text = normalize(output.body.textContent);
			missing = elements.filter(element => !text.includes(normalize(element.textContent))).map(element => normalize(element.textContent));
		} else if (kind === 'images') {
			const found = new Set([...output.querySelectorAll('img[src]')].map(image => new URL(image.getAttribute('src'), url).href));
			missing = elements.map(image => new URL(image.getAttribute('src'), url).href).filter(src => !found.has(src));
		} else if (kind === 'links') {
			const found = [...output.querySelectorAll('a[href]')].map(a => `${normalize(a.textContent)}\n${new URL(a.getAttribute('href'), url).href}`);
			missing = missingOccurrences(elements.filter(a => a.textContent.trim() && a.getAttribute('href')?.startsWith('#'))
				.map(a => `${normalize(a.textContent)}\n${new URL(a.getAttribute('href'), url).href}`), found);
		} else throw new Error(`Unknown source check: ${kind}`);
		checks.push({ kind, selector, expected: elements.length, missing: missing.length,
			passed: elements.length > 0 && !missing.length, missingExamples: missing.slice(0, 3) });
	}
	return checks;
}

export async function runAcceptance(manifest, outputDir) {
	if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.cases) || !manifest.cases.length) throw new Error('Expected a nonempty schemaVersion 1 acceptance manifest.');
	const ids = new Set();
	for (const item of manifest.cases) {
		if (!/^[a-z0-9-]+$/.test(item.id) || ids.has(item.id)) throw new Error('Case IDs must be unique lowercase names.');
		if (![0, 2].includes(item.expectedExit)) throw new Error('Each case must declare expectedExit 0 or 2.');
		ids.add(item.id);
	}
	await mkdir(outputDir, { recursive: true });
	const directory = await mkdtemp(path.join(outputDir, 'run-'));
	const report = { schemaVersion: 1, startedAt: new Date().toISOString(), mode: 'offline-replay', items: [] };
	const reportPath = path.join(directory, 'report.json');
	for (const specification of manifest.cases) {
		const item = { id: specification.id, name: specification.name, url: specification.url, status: 'failed', errors: [] };
		try {
			let result;
			let html;
			let markdownPath;
			if (specification.exportPair) {
				const input = path.resolve(root, specification.exportPair);
				result = await clip(clipOptions([input, '-o', path.join(directory, specification.id)]));
				const paper = result.report.items[0];
				item.details = paper.paperReport;
				html = await readFile(paper.snapshotHtml, 'utf8');
				markdownPath = paper.output;
			} else {
				const capture = JSON.parse(await readFile(path.resolve(root, specification.captureReport), 'utf8'));
				const attempt = capture.attempts.findLast(attempt => attempt.html && (!specification.sourceMode || attempt.mode === specification.sourceMode));
				if (!attempt) throw new Error('No matching retained HTML capture.');
				html = await readFile(attempt.html, 'utf8');
				const args = [specification.url, '--html', attempt.html, '-o', path.join(directory, `${specification.id}.md`)];
				for (const heading of specification.requiredSections ?? []) args.push('--require-section', heading);
				result = await clipPaper(paperOptions(args));
				item.details = path.join(result.report.artifactDirectory, 'report.json');
				markdownPath = result.report.outputWritten ? result.report.output : result.report.attempts.at(-1)?.markdown;
			}
			item.actualExit = result.exitCode;
			item.markdown = markdownPath;
			if (result.exitCode !== specification.expectedExit) item.errors.push(`Expected exit ${specification.expectedExit}, got ${result.exitCode}.`);
			const markdown = markdownPath ? await readFile(markdownPath, 'utf8') : '';
			item.metrics = markdownMetrics(markdown);
			if (specification.expectedExit === 2) {
				const details = JSON.parse(await readFile(item.details, 'utf8'));
				item.reasons = details.attempts.flatMap(attempt => attempt.quality?.reasons ?? []);
				for (const reason of specification.requiredReasons ?? []) if (!item.reasons.includes(reason)) item.errors.push(`Missing rejection reason: ${reason}`);
				if (details.outputWritten) item.errors.push('Rejected input must not publish Markdown.');
				if (!item.errors.length) item.status = 'expected-rejection';
			} else {
				for (const [metric, minimum] of Object.entries(specification.minimums ?? {})) {
					if (typeof item.metrics[metric] !== 'number' || item.metrics[metric] < minimum) item.errors.push(`${metric} below minimum ${minimum}.`);
				}
				for (const heading of specification.requiredSections ?? []) if (!item.metrics.headings.includes(heading)) item.errors.push(`Missing heading: ${heading}`);
				item.sourceChecks = auditSource(html, markdown, specification.url, specification.sourceChecks);
				for (const check of item.sourceChecks) if (!check.passed) item.errors.push(`${check.kind}: ${check.missing}/${check.expected} source items missing or selector empty.`);
				if (specification.reference) {
					item.reference = compareReference(markdown, await readFile(path.resolve(root, specification.reference), 'utf8'), { ...specification, sourceHtml: html });
					if (!item.reference.passed) item.errors.push('Manual reference comparison failed.');
				}
				if (!item.errors.length) item.status = specification.reference ? (specification.referenceMissingNatureLegends ? 'reference-plus-source-legends' : 'reference-match') : 'structural-only';
			}
		} catch (error) { item.errors.push(error.message); }
		report.items.push(item);
		await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
		console.log(`[${item.status}] ${item.id}${item.errors.length ? ': ' + item.errors.join(' ') : ''}`);
	}
	report.finishedAt = new Date().toISOString();
	report.exitCode = report.items.some(item => item.status === 'failed') ? 1 : 0;
	await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
	const lines = ['# Paper Acceptance', '', `Mode: ${report.mode}. Structural checks are not manual full-text equivalence.`, '',
		'| Case | Result | Words | Math | Tables | Images | Reference definitions |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |'];
	for (const item of report.items) {
		const m = item.metrics ?? {};
		lines.push(`| ${item.id} | ${item.status} | ${m.bodyWords ?? '-'} | ${m.mathExpressions ?? '-'} | ${m.tables ?? '-'} | ${m.images ?? '-'} | ${m.footnoteDefinitions ?? '-'} |`);
	}
	for (const item of report.items.filter(item => item.errors.length)) lines.push('', `## ${item.id}`, ...item.errors.map(error => `- ${error.replace(/\s+/g, ' ')}`));
	await writeFile(path.join(directory, 'summary.md'), lines.join('\n') + '\n');
	console.log(`Acceptance report: ${reportPath}`);
	return { exitCode: report.exitCode, report, reportPath };
}

export async function main(args = process.argv.slice(2)) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
		manifest: { type: 'string', short: 'm', default: path.join(root, 'scripts/fixtures/paper-acceptance.json') },
		'output-dir': { type: 'string', short: 'o', default: path.join(root, 'output/browser-fetch/acceptance/runs') },
		help: { type: 'boolean', short: 'h' },
	} });
	if (values.help) { console.log('Usage: npm run accept:papers -- [--manifest file.json] [-o directory]\nOffline replay only. Local captures/manual baselines are required and never changed.'); return 0; }
	if (positionals.length || !values.manifest.trim() || !values['output-dir'].trim()) throw new Error('Use --manifest and --output-dir with nonempty paths.');
	const manifest = JSON.parse(await readFile(path.resolve(values.manifest), 'utf8'));
	return (await runAcceptance(manifest, path.resolve(values['output-dir']))).exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
