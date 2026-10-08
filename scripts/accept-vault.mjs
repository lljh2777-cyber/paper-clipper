import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { archivePapers, parseOptions, splitFrontmatter } from './archive-papers.mjs';
import { collectImages } from './paper-assets.mjs';

export async function main(args = process.argv.slice(2)) {
	const { values } = parseArgs({ args, options: { 'asset-report': { type: 'string' }, vault: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
	if (values.help) { console.log('Usage: npm run accept:vault -- --asset-report <successful-asset-report.json> --vault <trial-vault>\nPlans, archives and repeats the given accepted papers. No files are overwritten or deleted.'); return 0; }
	if (!values['asset-report'] || !values.vault) throw new Error('--asset-report and --vault are required.');
	const source = JSON.parse(await readFile(path.resolve(values['asset-report']), 'utf8'));
	if (source.mode !== 'saved-html-live-assets-offline-render' || source.exitCode !== 0 || !source.items?.length || source.items.some(item => item.status !== 'passed')) throw new Error('Use a successful asset acceptance report.');
	const inputArgs = [...source.items.map(item => item.markdown), '--vault', values.vault];
	const preview = await archivePapers(parseOptions([...inputArgs, '--dry-run']));
	assert.equal(preview.exitCode, 0);
	const first = await archivePapers(parseOptions(inputArgs));
	assert.equal(first.exitCode, 0);
	const checks = [];
	const snapshots = [];
	for (const item of first.report.items) {
		const input = await readFile(item.input);
		const note = await readFile(item.output);
		assert.equal(splitFrontmatter(note.toString('utf8')).body, splitFrontmatter(input.toString('utf8')).body);
		const images = collectImages(note.toString('utf8'));
		for (const image of images) {
			const relative = decodeURIComponent(image.url);
			assert.deepEqual(await readFile(path.resolve(path.dirname(item.output), relative)), await readFile(path.resolve(path.dirname(item.input), relative)));
		}
		checks.push({ title: item.metadata.title, doi: item.metadata.doi, output: item.output, bodyUnchanged: true, verifiedImageOccurrences: images.length, uniqueAttachments: item.attachments, metadataGaps: item.metadata.metadata_gaps });
		for (const file of [item.input, item.output, ...new Set(images.map(image => path.resolve(path.dirname(item.output), decodeURIComponent(image.url))))]) {
			snapshots.push({ file, bytes: await readFile(file), modified: (await stat(file)).mtimeMs });
		}
	}
	const repeated = await archivePapers(parseOptions(inputArgs));
	assert.equal(repeated.exitCode, 0);
	assert.equal(repeated.report.counts.duplicate, source.items.length);
	assert.equal(repeated.report.counts.archived, 0);
	for (const snapshot of snapshots) {
		assert.deepEqual(await readFile(snapshot.file), snapshot.bytes);
		assert.equal((await stat(snapshot.file)).mtimeMs, snapshot.modified);
	}
	const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), vault: first.report.vault,
		preview: preview.report.counts, first: first.report.counts, repeat: repeated.report.counts,
		originalsAndArchivedFilesUnchangedOnRepeat: true, checks, archiveReport: first.reportPath, repeatReport: repeated.reportPath };
	const reportPath = path.join(path.dirname(first.reportPath), 'acceptance.json');
	await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
	console.log(JSON.stringify(report, null, 2));
	console.log(`Vault acceptance report: ${reportPath}`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
