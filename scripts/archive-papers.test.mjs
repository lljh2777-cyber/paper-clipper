import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { archivePapers, parseOptions, splitFrontmatter } from './archive-papers.mjs';
import { canonicalUrl, normalizeDoi, paperMetadata } from './paper-metadata.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDXsAAAAASUVORK5CYII=', 'base64');
let directory;
before(async () => {
	await mkdir(path.join(root, 'output/browser-fetch/tests'), { recursive: true });
	directory = await mkdtemp(path.join(root, 'output/browser-fetch/tests/vault-'));
});

const html = (doi = '10.1234/example', title = 'Original Paper Title') => `<html><head><meta name="citation_title" content="${title}">
<meta name="citation_author" content="Alice Example"><meta name="citation_author" content="Bob Example">
<meta name="citation_publication_date" content="2024/02/03"><meta name="citation_journal_title" content="Test Journal">
${doi ? `<meta name="citation_doi" content="${doi}"><meta name="dc.identifier" content="doi:${doi}">` : ''}
</head><body><h1>${title}</h1><h2>Results</h2><p>References may cite 10.5555/not-this-paper.</p></body></html>`;

async function fixture(name, { doi = '10.1234/example', url = 'https://publisher.example/article', title = 'Original Paper Title', images = true } = {}) {
	const inputDir = path.join(directory, name, 'input');
	await mkdir(inputDir, { recursive: true });
	const input = path.join(inputDir, 'paper.md');
	const artifacts = path.join(`${input}.runs`, 'run-fixture');
	await mkdir(artifacts, { recursive: true });
	const body = `## Results\n\nKeep prose, $x_i + \\alpha$, and [citations](https://example.com/reference).\n\n## Methods\n\nOriginal methods.\n${images ? '\n![Figure](<images/image.png> "caption")\n' : ''}`;
	const markdown = `---\ntitle: "Original template title"\nsource: "${url}"\ntags: [reading, paper]\ncustom:\n  rating: 3\n---\n${body}`;
	await writeFile(input, markdown);
	await writeFile(path.join(artifacts, 'accepted.md'), markdown);
	await writeFile(path.join(artifacts, 'file.html'), html(doi, title));
	const report = { output: input, artifactDirectory: artifacts, status: 'passed-checks', outputWritten: true,
		finishedAt: '2026-10-08T00:00:00.000Z', attempts: [{ status: 'passed-checks', quality: { passed: true },
			contentUrl: url, html: path.join(artifacts, 'file.html'), capture: { capturedAt: '2026-10-07T12:44:00.000Z' } }] };
	if (images) {
		await mkdir(path.join(inputDir, 'images'));
		const file = path.join(inputDir, 'images/image.png');
		await writeFile(file, png);
		report.assets = { status: 'complete', failed: 0, items: [{ status: 'downloaded', file, relativePath: 'images/image.png', bytes: png.length, contentType: 'image/png' }] };
	}
	await writeFile(`${input}.report.json`, JSON.stringify(report));
	const vault = path.join(directory, name, 'Vault');
	return { input, inputDir, artifacts, body, markdown, report, vault, options: extra => parseOptions([input, '--vault', vault, ...extra ?? []]) };
}

test('publisher metadata preserves original title/authors and records missing fields instead of guessing from references', () => {
	const metadata = paperMetadata(html('10.1234/ABC'), { url: 'https://publisher.example/article?utm_source=x#refs' });
	assert.equal(metadata.title, 'Original Paper Title');
	assert.deepEqual(metadata.authors, ['Alice Example', 'Bob Example']);
	assert.equal(metadata.year, 2024);
	assert.equal(metadata.doi, '10.1234/abc');
	assert.equal(metadata.source, 'https://publisher.example/article');
	assert.equal(metadata.captured_at, null);
	assert.ok(metadata.metadata_gaps.includes('captured_at'));
	assert.equal(paperMetadata(html(null), { url: metadata.source }).doi, null);
	assert.throws(() => paperMetadata(html().replace('</head>', '<meta name="citation_doi" content="10.1234/other"></head>'), { url: metadata.source }), /Conflicting/);
	assert.throws(() => paperMetadata(html(), { url: 'https://doi.org/10.1234/other' }), /conflicts/);
});

test('normalizes DOI and source identity conservatively', () => {
	assert.equal(normalizeDoi(' DOI:10.1234/ABC '), '10.1234/abc');
	assert.equal(normalizeDoi('https://doi.org/10.1234%2FABC'), '10.1234/abc');
	assert.throws(() => normalizeDoi('https://example.com/10.1234/a'));
	assert.throws(() => normalizeDoi('10.1/wrong'));
	assert.equal(canonicalUrl('https://EXAMPLE.com:443/article?z=1&id=a&utm_source=test#fig1'), 'https://example.com/article?id=a&z=1');
	assert.notEqual(canonicalUrl('https://example.com/article?id=a'), canonicalUrl('https://example.com/article?id=b'));
});

test('argument and YAML validation reject unsafe directories, ambiguous mappings and overwrite flags', () => {
	assert.deepEqual(parseOptions(['--help']), { help: true });
	for (const args of [[], ['paper.md'], ['paper.md', '--vault', ''], ['paper.md', '--vault', 'vault', '--papers-dir', '../outside'],
		['paper.md', '--vault', 'vault', '--papers-dir', '.obsidian'], ['paper.md', '--vault', 'vault', '--papers-dir', 'Papers/..'],
		['paper.md', '--vault', 'vault', '--papers-dir', 'Papers:stream'], ['paper.md', '--vault', 'vault', '--overwrite']]) assert.throws(() => parseOptions(args));
	assert.throws(() => splitFrontmatter('---\ndoi: one\ndoi: two\n---\nbody'), /Invalid YAML/);
	assert.throws(() => splitFrontmatter('---\n- item\n---\nbody'), /mapping/);
	assert.equal(splitFrontmatter('plain body').body, 'plain body');
});

test('dry-run validates and plans without creating a Vault or touching source files', async () => {
	const f = await fixture('dry-run');
	const previous = await stat(f.input);
	const result = await archivePapers(f.options(['--dry-run']));
	assert.equal(result.exitCode, 0);
	assert.equal(result.report.counts.planned, 1);
	assert.equal(result.reportPath, undefined);
	await assert.rejects(stat(f.vault), { code: 'ENOENT' });
	assert.equal((await stat(f.input)).mtimeMs, previous.mtimeMs);
	assert.equal(await readFile(f.input, 'utf8'), f.markdown);
});

test('standalone archive rechecks Nature legends in old accepted snapshots before deduplication, including dry run', async () => {
	for (const [name, legend] of [['missing', ''], ['shortened', 'Detailed.'], ['complete', 'Detailed panel description.']]) {
		const f = await fixture(`nature-caption-${name}`, { url: 'https://www.nature.com/articles/fixture' });
		const source = html().replace('</body>', '<figure><figcaption>Fig. 1: Overview.</figcaption><img src="/figure.png"><div class="c-article-section__figure-description" id="figure-1-desc"><p>Detailed panel description.</p></div></figure></body>');
		const markdown = f.markdown + `\nFig. 1: Overview.\n\n${legend}\n`;
		await writeFile(path.join(f.artifacts, 'file.html'), source);
		await writeFile(f.input, markdown);
		await writeFile(path.join(f.artifacts, 'accepted.md'), markdown);
		const dry = await archivePapers(f.options(['--dry-run']));
		assert.equal(dry.exitCode, name === 'complete' ? 0 : 1);
		await assert.rejects(stat(f.vault), { code: 'ENOENT' });
		if (name === 'complete') {
			assert.equal(dry.report.items[0].figureCaptions.status, 'passed');
			assert.equal(dry.report.items[0].figureCaptions.matched, 1);
			assert.equal((await archivePapers(f.options())).report.counts.archived, 1);
		} else {
			await mkdir(f.vault, { recursive: true });
			const existing = path.join(f.vault, 'existing.md');
			const annotation = '---\ndoi: 10.1234/example\n---\nKeep user annotations.\n';
			await writeFile(existing, annotation);
			const result = await archivePapers(f.options());
			assert.equal(result.report.counts.duplicate, 0);
			assert.equal(result.report.items[0].code, 'figure-captions');
			assert.equal(result.report.items[0].quality.figureCaptions.figures[0].title, 'Fig. 1: Overview.');
			assert.equal(await readFile(existing, 'utf8'), annotation);
			await assert.rejects(stat(path.join(f.vault, 'Papers')), { code: 'ENOENT' });
		}
		assert.equal(await readFile(f.input, 'utf8'), markdown);
	}
});

test('archive preserves custom metadata, exact body and image bytes; repeat preserves user annotations', async () => {
	const f = await fixture('archive');
	const result = await archivePapers(f.options());
	assert.equal(result.exitCode, 0);
	assert.equal(result.report.counts.archived, 1);
	const output = result.report.items[0].output;
	const archived = await readFile(output, 'utf8');
	const note = splitFrontmatter(archived);
	assert.equal(note.body, f.body);
	assert.equal(note.properties.title, 'Original Paper Title');
	assert.deepEqual(note.properties.tags, ['reading', 'paper']);
	assert.deepEqual(note.properties.custom, { rating: 3 });
	assert.equal(note.properties.captured_at, '2026-10-07T12:44:00.000Z');
	assert.deepEqual(await readFile(path.join(path.dirname(output), 'images/image.png')), png);
	assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).counts.archived, 1);
	const annotated = archived + '\n## My notes\n\nKeep my annotation.\n';
	await writeFile(output, annotated);
	const timestamp = (await stat(output)).mtimeMs;
	const repeated = await archivePapers(f.options());
	assert.equal(repeated.report.counts.duplicate, 1);
	assert.equal(await readFile(output, 'utf8'), annotated);
	assert.equal((await stat(output)).mtimeMs, timestamp);
	assert.equal((await readdir(path.join(f.vault, 'Papers'))).length, 1);
	await assert.rejects(stat(path.join(f.vault, '.paper-clipper/archive.lock')), { code: 'ENOENT' });
});

test('DOI deduplication finds manually written notes elsewhere in the Vault even with a different source URL', async () => {
	const f = await fixture('manual');
	await mkdir(path.join(f.vault, 'Reading'), { recursive: true });
	const manual = path.join(f.vault, 'Reading', 'renamed.md');
	const text = '---\ntitle: A hand-edited title\ndoi: https://doi.org/10.1234/EXAMPLE\nsource: https://another.example/paper\n---\nPersonal notes.\n';
	await writeFile(manual, text);
	const result = await archivePapers(f.options());
	assert.equal(result.report.counts.duplicate, 1);
	assert.equal(result.report.items[0].output, manual);
	assert.equal(await readFile(manual, 'utf8'), text);
	await assert.rejects(stat(path.join(f.vault, 'Papers')), { code: 'ENOENT' });
});

test('canonical URL fallback skips unknown DOI while different DOIs on the same URL produce a conflict', async () => {
	const f = await fixture('url-fallback', { doi: null, url: 'https://publisher.example/article?id=123&utm_medium=mail#fig1' });
	await mkdir(f.vault, { recursive: true });
	await writeFile(path.join(f.vault, 'existing.md'), '---\nsource: https://publisher.example/article?id=123\n---\nExisting.');
	assert.equal((await archivePapers(f.options())).report.counts.duplicate, 1);
	const conflict = await fixture('url-conflict');
	await mkdir(conflict.vault, { recursive: true });
	await writeFile(path.join(conflict.vault, 'existing.md'), '---\ndoi: 10.1234/different\nsource: https://publisher.example/article\n---\nExisting.');
	const result = await archivePapers(conflict.options());
	assert.equal(result.exitCode, 1);
	assert.match(result.report.items[0].error, /different DOI/);
});

test('different DOI papers with the same title remain separate and a repeated batch input is planned only once', async () => {
	const first = await fixture('same-title-one');
	const second = await fixture('same-title-two', { doi: '10.1234/second', url: 'https://publisher.example/second' });
	const duplicate = await fixture('same-doi', { doi: '10.1234/EXAMPLE', url: 'https://mirror.example/one' });
	const options = parseOptions([first.input, second.input, duplicate.input, '--vault', first.vault, '--dry-run']);
	const result = await archivePapers(options);
	assert.deepEqual(result.report.counts, { planned: 2, archived: 0, duplicate: 1, failed: 0 });
	assert.notEqual(result.report.items.find(item => item.input === first.input).output, result.report.items.find(item => item.input === second.input).output);
	await assert.rejects(stat(first.vault), { code: 'ENOENT' });
});

test('incomplete reports, modified Markdown, remote/partial/missing images are not archived', async () => {
	for (const kind of ['incomplete', 'edited', 'partial', 'remote', 'missing']) {
		const f = await fixture(`reject-${kind}`);
		if (kind === 'incomplete') f.report.status = 'incomplete';
		if (kind === 'edited') await writeFile(f.input, f.markdown + '\nchanged');
		if (kind === 'partial') f.report.assets.status = 'partial';
		if (kind === 'remote') {
			const changed = f.markdown.replace('images/image.png', 'https://images.example/image.png');
			await writeFile(f.input, changed);
			await writeFile(path.join(f.artifacts, 'accepted.md'), changed);
		}
		if (kind === 'missing') f.report.assets.items[0].relativePath = 'different.png';
		await writeFile(`${f.input}.report.json`, JSON.stringify(f.report));
		const result = await archivePapers(f.options());
		assert.equal(result.exitCode, 1, kind);
		assert.equal(result.report.counts.archived, 0, kind);
		await assert.rejects(stat(path.join(f.vault, 'Papers')), { code: 'ENOENT' });
	}
});

test('top-level discovery excludes unrelated Markdown and continues after one failed paper', async () => {
	const f = await fixture('discovery', { images: false });
	await writeFile(path.join(f.inputDir, 'summary.md'), '# Summary');
	await writeFile(path.join(f.inputDir, 'orphan.md.report.json'), '{}');
	const result = await archivePapers(parseOptions([f.inputDir, '--vault', f.vault]));
	assert.equal(result.report.counts.archived, 1);
	assert.equal(result.report.counts.failed, 1);
	assert.equal(result.report.items.length, 2);
});

test('occupied destination and another process lock are preserved', async () => {
	const f = await fixture('occupied');
	const planned = await archivePapers(f.options(['--dry-run']));
	const folder = path.dirname(planned.report.items[0].output);
	await mkdir(folder, { recursive: true });
	await writeFile(path.join(folder, 'keep.txt'), 'Keep');
	const result = await archivePapers(f.options());
	assert.equal(result.exitCode, 1);
	assert.equal(await readFile(path.join(folder, 'keep.txt'), 'utf8'), 'Keep');
	const lock = path.join(f.vault, '.paper-clipper/archive.lock');
	await writeFile(lock, 'Another import');
	await assert.rejects(archivePapers(f.options()), /lock exists/);
	assert.equal(await readFile(lock, 'utf8'), 'Another import');
});

test('directory links and artifact paths escaping the paper are refused', async () => {
	const f = await fixture('links');
	const other = path.join(directory, 'outside');
	await mkdir(other);
	await mkdir(f.vault);
	await symlink(other, path.join(f.vault, 'Papers'), process.platform === 'win32' ? 'junction' : 'dir');
	await assert.rejects(archivePapers(f.options()), /plain directory/);
	assert.deepEqual(await readdir(other), []);
	const escaped = await fixture('escaped-report');
	escaped.report.attempts[0].html = path.join(directory, 'outside.html');
	await writeFile(`${escaped.input}.report.json`, JSON.stringify(escaped.report));
	const result = await archivePapers(escaped.options(['--dry-run']));
	assert.equal(result.exitCode, 1);
	assert.match(result.report.items[0].error, /bounded successful source/);
});
