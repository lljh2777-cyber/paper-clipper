import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { coreFiles, corePackage, exportCore } from './export-paper-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let directory;
before(async () => {
	const parent = path.join(root, 'output/core-export-tests');
	await mkdir(parent, { recursive: true });
	directory = await mkdtemp(path.join(parent, 'run-'));
});

test('core dependency list excludes extension tools and uses existing locked versions', async () => {
	const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
	const pkg = corePackage(lock);
	assert.equal(Object.keys(pkg.dependencies).length, 10);
	assert.deepEqual(Object.keys(pkg.devDependencies), ['esbuild']);
	assert.equal(pkg.dependencies.defuddle, lock.packages['node_modules/defuddle'].version);
	assert.equal(pkg.private, true);
	assert.equal(pkg.scripts['build:chrome'], undefined);
	assert.throws(() => corePackage({ packages: {} }), /Missing locked dependency/);
	assert.equal(new Set(coreFiles).size, coreFiles.length);
});

test('dry run validates without creating output', async () => {
	const output = path.join(directory, 'dry');
	const result = await exportCore(output, { dryRun: true });
	assert.equal(result.status, 'would-export');
	assert.equal(result.sourceFiles, 20);
	await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('export contains only allowlisted sources and safe documentation, preserving bytes', async () => {
	const output = path.join(directory, 'core');
	const result = await exportCore(output);
	assert.equal(result.status, 'exported');
	const manifest = JSON.parse(await readFile(path.join(output, 'core-manifest.json'), 'utf8'));
	assert.equal(result.files, manifest.files.length + 1);
	for (const name of ['LICENSE', 'src/api.ts', 'scripts/save-paper.mjs', 'scripts/clip-paper.test.mjs']) {
		assert.deepEqual(await readFile(path.join(root, name)), await readFile(path.join(output, name)));
	}
	assert.ok(!manifest.files.some(file => /^(?:output|node_modules|dist|assets|\.browser-profile)\//.test(file)));
	assert.ok(!manifest.files.includes('skills/paper-clipper/runtime.json'));
	assert.ok(!manifest.files.includes('src/manifest.json'));
	assert.match(await readFile(path.join(output, 'README.md'), 'utf8'), /not an Obsidian extension/);
	assert.doesNotMatch(await readFile(path.join(output, 'docs/html-export.md'), 'utf8'), /npm run build:chrome/);
	const lock = JSON.parse(await readFile(path.join(output, 'package-lock.json'), 'utf8'));
	const pkg = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
	assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
	assert.equal(lock.name, pkg.name);
	await writeFile(path.join(output, 'sentinel.txt'), 'personal');
	await assert.rejects(exportCore(output), /Destination already exists/);
	assert.equal(await readFile(path.join(output, 'sentinel.txt'), 'utf8'), 'personal');
});

test('file destinations and linked parents are refused without writing into targets', async () => {
	const file = path.join(directory, 'file.txt');
	await writeFile(file, 'keep');
	await assert.rejects(exportCore(file), /already exists/);
	await assert.rejects(exportCore(path.join(file, 'core')), /Not a plain directory/);
	const target = path.join(directory, 'target');
	await mkdir(target);
	const link = path.join(directory, 'linked');
	await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
	await assert.rejects(exportCore(path.join(link, 'core')), /Not a plain directory/);
	assert.deepEqual(await readdir(target), []);
});
