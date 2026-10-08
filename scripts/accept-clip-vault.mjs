import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { clip, parseOptions } from './clip.mjs';
import { splitFrontmatter } from './archive-papers.mjs';
import { collectImages } from './paper-assets.mjs';

export async function main(args = process.argv.slice(2)) {
	const { values } = parseArgs({ args, options: { report: { type: 'string', multiple: true } } });
	if (!values.report?.length) throw new Error('Usage: npm run accept:clip-vault -- --report <first-clip-report.json> [--report <another-report.json>]\nChecks archived bodies/images, repeats each unified command, and verifies no existing source/note/attachment changes.');
	const results = [];
	for (const input of values.report) {
		const reportPath = path.resolve(input);
		const first = JSON.parse(await readFile(reportPath, 'utf8'));
		assert.equal(first.exitCode, 0);
		assert.ok(first.items?.length > 0 && first.items.every(item => item.status === 'success' && item.archive?.status === 'archived'));
		const snapshots = new Map();
		const retain = async file => snapshots.set(file, { bytes: await readFile(file), modified: (await stat(file)).mtimeMs });
		const checks = [];
		for (const item of first.items) {
			const note = await readFile(item.archive.output, 'utf8');
			const converted = await readFile(item.output, 'utf8');
			assert.equal(splitFrontmatter(note).body, splitFrontmatter(converted).body);
			const images = collectImages(note);
			for (const image of images) {
				const relative = decodeURIComponent(image.url);
				const copied = path.resolve(path.dirname(item.archive.output), relative);
				const original = path.resolve(path.dirname(item.output), relative);
				assert.deepEqual(await readFile(copied), await readFile(original));
				await retain(original);
				await retain(copied);
			}
			await retain(item.output);
			await retain(item.archive.output);
			await retain(path.join(path.dirname(item.archive.output), 'paper.json'));
			if (first.route === 'import') {
				await retain(item.input);
				await retain(`${item.input}.json`);
			}
			checks.push({ title: item.title, bodyUnchanged: true, attachments: new Set(images.map(image => image.url)).size,
				imageOccurrences: images.length, capturedAt: splitFrontmatter(note).properties.captured_at });
		}
		const config = parseOptions([first.input, '-o', first.outputDir, '--download-assets', '--vault', first.archive.vault,
			'--papers-dir', path.relative(first.archive.vault, first.archive.papersDir)]);
		const repeated = await clip(config);
		assert.equal(repeated.exitCode, 0);
		assert.equal(repeated.report.counts.skipped, first.items.length);
		assert.equal(repeated.report.archive.counts.duplicate, first.items.length);
		assert.equal(repeated.report.archive.counts.archived, 0);
		for (const [file, original] of snapshots) {
			assert.deepEqual(await readFile(file), original.bytes);
			assert.equal((await stat(file)).mtimeMs, original.modified);
		}
		results.push({ route: first.route, firstReport: reportPath, repeatReport: repeated.reportPath, checks,
			unchangedFiles: snapshots.size, repeatedConversion: repeated.report.counts, repeatedArchive: repeated.report.archive.counts });
	}
	const directory = await mkdtemp(path.join(path.dirname(path.resolve(values.report[0])), 'verification-'));
	const reportPath = path.join(directory, 'report.json');
	await writeFile(reportPath, JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), results }, null, 2) + '\n', { flag: 'wx' });
	console.log(JSON.stringify(results, null, 2));
	console.log(`Unified Vault acceptance: ${reportPath}`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
