import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { auditSource, compareReference, markdownMetrics } from './accept-papers.mjs';
import { clipPaper, parseOptions as paperOptions } from './clip-paper.mjs';
import { clip, parseOptions as clipOptions } from './clip.mjs';
import { collectImages, imageExtension } from './paper-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const escapeHtml = text => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]);

function withoutImages(markdown, images) {
	for (const image of [...images].sort((a, b) => b.start - a.start)) markdown = markdown.slice(0, image.start) + '[IMAGE]' + markdown.slice(image.end);
	return markdown;
}

export async function auditLocalizedMarkdown(original, markdown, assets, output, url) {
	const before = collectImages(original);
	const after = collectImages(markdown);
	const errors = [];
	if (before.length !== after.length) errors.push('Image occurrence count changed.');
	// HTML srcset removal is expected; all other text outside image replacements must match.
	const originalWithoutSrcset = before.filter(image => image.remove).reduceRight((text, image) =>
		text.slice(0, image.remove.start) + text.slice(image.remove.end), original);
	if (withoutImages(originalWithoutSrcset, collectImages(originalWithoutSrcset)) !== withoutImages(markdown, after)) errors.push('Text outside images changed.');
	for (const [index, image] of before.entries()) {
		let source;
		try { const parsed = new URL(image.url, url); parsed.hash = ''; source = parsed.href; } catch { source = image.url; }
		const item = assets.items.find(item => item.source === source);
		if (!item) { errors.push(`Image ${index + 1} has no report entry.`); continue; }
		if (after[index]?.url !== (item.status === 'downloaded' ? item.relativePath : image.url)) errors.push(`Image ${index + 1} destination mismatch.`);
		if (image.format === 'markdown' && (image.alt !== after[index]?.alt || image.title !== after[index]?.title)) errors.push(`Image ${index + 1} label/title changed.`);
	}
	for (const item of assets.items.filter(item => item.status === 'downloaded')) {
		const file = path.resolve(path.dirname(output), decodeURIComponent(item.relativePath));
		const relative = path.relative(path.dirname(output), file);
		if (relative.startsWith('..') || path.isAbsolute(relative) || file !== item.file) { errors.push('Attachment path escapes its output directory.'); continue; }
		try {
			const bytes = await readFile(file);
			if (bytes.length !== item.bytes) errors.push(`Attachment size mismatch: ${item.relativePath}`);
			imageExtension(bytes, item.contentType);
		} catch (error) { errors.push(error.message); }
	}
	return { passed: !errors.length, occurrences: before.length, errors };
}

async function renderOffline(browser, markdown, output, id) {
	const images = collectImages(markdown);
	const gallery = path.join(path.dirname(output), `${id}.images.html`);
	const screenshot = path.join(path.dirname(output), `${id}.images.png`);
	const cards = images.map((image, index) => `<figure><figcaption>${index + 1}. ${escapeHtml(image.alt || 'Image')}</figcaption><img src="${escapeHtml(image.url)}"></figure>`).join('\n');
	await writeFile(gallery, '<!doctype html><meta charset="utf-8"><title>Offline image verification</title>' +
		'<style>body{margin:20px;font:14px Arial;background:white;color:#222}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}figure{margin:0;border:1px solid #bbb;padding:8px;min-width:0}figcaption{margin-bottom:8px}img{width:100%;height:200px;object-fit:contain}</style>' +
		`<h1>${escapeHtml(id)}</h1><main>${cards}</main>`);
	const context = await browser.newContext({ offline: true, viewport: { width: 1200, height: 900 } });
	try {
		const page = await context.newPage();
		await page.goto(pathToFileURL(gallery).href, { waitUntil: 'load' });
		const decoded = await page.locator('img').evaluateAll(async elements => Promise.all(elements.map(async img => {
			try { await img.decode(); } catch { /* A failed decode is reported below. */ }
			return { source: img.getAttribute('src'), width: img.naturalWidth, height: img.naturalHeight, loaded: img.complete && img.naturalWidth > 0 };
		})));
		await page.screenshot({ path: screenshot, fullPage: true });
		return { offline: true, images: decoded.length, decoded: decoded.filter(image => image.loaded).length, failures: decoded.filter(image => !image.loaded), gallery, screenshot };
	} finally { await context.close(); }
}

export async function runAssetAcceptance(manifest, outputDir) {
	if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.cases)) throw new Error('Expected schemaVersion 1 acceptance cases.');
	await mkdir(outputDir, { recursive: true });
	const directory = await mkdtemp(path.join(outputDir, 'run-'));
	const reportPath = path.join(directory, 'report.json');
	const report = { schemaVersion: 1, mode: 'saved-html-live-assets-offline-render', startedAt: new Date().toISOString(), directory, items: [] };
	const browser = await chromium.launch();
	try {
		for (const spec of manifest.cases.filter(item => item.expectedExit === 0)) {
			const item = { id: spec.id, status: 'failed', errors: [] };
			try {
				if (!/^[a-z0-9-]+$/.test(spec.id)) throw new Error('Invalid sample ID.');
				let result;
				let details;
				let html;
				if (spec.exportPair) {
					result = await clip(clipOptions([path.resolve(root, spec.exportPair), '-o', path.join(directory, spec.id), '--download-assets']));
					const paper = result.report.items[0];
					item.details = paper.paperReport;
					details = JSON.parse(await readFile(item.details, 'utf8'));
					html = await readFile(paper.snapshotHtml, 'utf8');
				} else {
					const capture = JSON.parse(await readFile(path.resolve(root, spec.captureReport), 'utf8'));
					const attempt = capture.attempts.findLast(attempt => attempt.html && (!spec.sourceMode || attempt.mode === spec.sourceMode));
					if (!attempt) throw new Error('No retained capture for sample.');
					html = await readFile(attempt.html, 'utf8');
					result = await clipPaper(paperOptions([spec.url, '--html', attempt.html, '-o', path.join(directory, `${spec.id}.md`), '--download-assets']));
					details = result.report;
					item.details = path.join(details.artifactDirectory, 'report.json');
				}
				if (result.exitCode || !details.outputWritten || !details.assets) throw new Error('Paper conversion or asset phase did not complete.');
				item.markdown = details.output;
				item.assets = details.assets;
				const original = await readFile(details.attempts.findLast(attempt => attempt.quality?.passed).markdown, 'utf8');
				const markdown = await readFile(item.markdown, 'utf8');
				item.preservation = await auditLocalizedMarkdown(original, markdown, item.assets, item.markdown, spec.url);
				item.errors.push(...item.preservation.errors);
				item.sourceChecks = auditSource(html, original, spec.url, spec.sourceChecks);
				for (const check of item.sourceChecks) if (!check.passed) item.errors.push(`Source check failed: ${check.kind}.`);
				if (spec.reference) {
					item.reference = compareReference(original, await readFile(path.resolve(root, spec.reference), 'utf8'), { ...spec, sourceHtml: html });
					if (!item.reference.passed) item.errors.push('Original Markdown reference comparison failed.');
				}
				const metrics = markdownMetrics(markdown);
				for (const heading of spec.requiredSections ?? []) if (!metrics.headings.includes(heading)) item.errors.push(`Missing heading: ${heading}.`);
				for (const [name, minimum] of Object.entries(spec.minimums ?? {})) if (metrics[name] < minimum) item.errors.push(`Metric below minimum: ${name}.`);
				item.equationImages = item.assets.items.filter(asset => /\.e\d+\b/.test(asset.source)).length;
				item.offline = await renderOffline(browser, markdown, item.markdown, spec.id);
				if (item.assets.failed) item.errors.push(`${item.assets.failed} image sources unresolved.`);
				if (item.offline.decoded !== item.offline.images) item.errors.push('Some images did not decode offline.');
				if (!item.errors.length) item.status = 'passed';
			} catch (error) { item.errors.push(error.message); }
			report.items.push(item);
			await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
			console.log(`[${item.status}] ${item.id}: ${item.assets?.downloaded ?? 0} unique attachments; ${item.offline?.decoded ?? 0}/${item.offline?.images ?? 0} images decoded offline. ${item.errors.join(' ')}`);
		}
	} finally { await browser.close(); }
	report.exitCode = !report.items.length || report.items.some(item => item.status !== 'passed') ? 1 : 0;
	report.finishedAt = new Date().toISOString();
	await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
	const lines = ['# Offline Image Acceptance', '', 'Saved HTML conversion; live image downloads; Chromium image decoding with networking disabled.', '',
		'| Sample | Status | Unique saved images | Equation images | Offline image occurrences |', '| --- | --- | ---: | ---: | --- |'];
	for (const item of report.items) lines.push(`| ${item.id} | ${item.status} | ${item.assets?.downloaded ?? 0} | ${item.equationImages ?? 0} | ${item.offline?.decoded ?? 0}/${item.offline?.images ?? 0} |`);
	for (const item of report.items.filter(item => item.errors.length)) lines.push('', `## ${item.id}`, ...item.errors.map(error => `- ${error}`));
	await writeFile(path.join(directory, 'summary.md'), lines.join('\n') + '\n');
	console.log(`Asset acceptance report: ${reportPath}`);
	return { exitCode: report.exitCode, report, reportPath };
}

export async function main(args = process.argv.slice(2)) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
		manifest: { type: 'string', default: path.join(root, 'scripts/fixtures/paper-acceptance.json') },
		'output-dir': { type: 'string', short: 'o', default: path.join(root, 'output/browser-fetch/asset-acceptance') },
		help: { type: 'boolean', short: 'h' },
	} });
	if (values.help) { console.log('Usage: npm run accept:assets -- [--manifest file.json] [-o directory]\nUses local paper captures, downloads live public images, and verifies image decoding offline in Chromium.'); return 0; }
	if (positionals.length || !values.manifest.trim() || !values['output-dir'].trim()) throw new Error('Use --manifest and --output-dir with nonempty paths.');
	return (await runAssetAcceptance(JSON.parse(await readFile(path.resolve(values.manifest), 'utf8')), path.resolve(values['output-dir']))).exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
