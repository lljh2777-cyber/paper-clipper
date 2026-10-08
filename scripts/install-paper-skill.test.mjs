import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseDocument } from 'yaml';
import { installSkill, parseOptions } from './install-paper-skill.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
let directory;
before(async () => {
	await mkdir(path.join(root, 'output/browser-fetch/tests'), { recursive: true });
	directory = await mkdtemp(path.join(root, 'output/browser-fetch/tests/install-skill-'));
});
const options = (name, extra = []) => parseOptions(['--skills-dir', path.join(directory, name, 'skills'), ...extra]);

test('installation defaults respect CODEX_HOME and explicit destinations; empty or unknown flags fail', () => {
	assert.equal(parseOptions([], {}, directory).destination, path.join(directory, '.codex/skills/paper-clipper'));
	assert.equal(parseOptions([], { CODEX_HOME: directory }).destination, path.join(directory, 'skills/paper-clipper'));
	assert.equal(options('explicit').destination, path.join(directory, 'explicit/skills/paper-clipper'));
	assert.throws(() => parseOptions(['--skills-dir', ' ']));
	assert.throws(() => parseOptions([], { CODEX_HOME: '' }));
	assert.throws(() => parseOptions(['--overwrite']));
	assert.throws(() => parseOptions(['unexpected']));
});

test('dry-run validates without creating the destination or its parent', async () => {
	const config = options('dry', ['--dry-run']);
	const result = await installSkill(config);
	assert.equal(result.status, 'would-install');
	await assert.rejects(stat(path.dirname(config.destination)), { code: 'ENOENT' });
});

test('installs exactly the instruction/UI/config files; installed runtime works from unrelated cwd', async () => {
	const config = options('fresh');
	assert.equal((await installSkill(config)).status, 'installed');
	assert.deepEqual((await readdir(config.destination)).sort(), ['SKILL.md', 'agents', 'runtime.json']);
	assert.deepEqual(await readdir(path.join(config.destination, 'agents')), ['openai.yaml']);
	assert.equal(await readFile(path.join(config.destination, 'SKILL.md'), 'utf8'), await readFile(path.join(root, 'skills/paper-clipper/SKILL.md'), 'utf8'));
	const runtime = JSON.parse(await readFile(path.join(config.destination, 'runtime.json'), 'utf8'));
	assert.equal(runtime.repositoryRoot, root);
	assert.equal(runtime.entryPoint, path.join(root, 'scripts/save-paper.mjs'));
	const { stdout } = await exec(runtime.nodeExecutable, [runtime.entryPoint, '10.1234/skill-fixture', '--resolve-only'], { cwd: directory });
	const result = JSON.parse(stdout);
	assert.equal(result.status, 'resolved');
	assert.equal(result.saved, false);
	assert.equal(result.resolution.selected.doi, '10.1234/skill-fixture');
	const yaml = parseDocument(await readFile(path.join(config.destination, 'agents/openai.yaml'), 'utf8'));
	assert.deepEqual(yaml.errors, []);
	const metadata = yaml.toJS();
	assert.notEqual(metadata.policy?.allow_implicit_invocation, false);
	assert.match(metadata.interface.default_prompt, /\$paper-clipper\b/);
	assert.ok(metadata.interface.short_description.length >= 25 && metadata.interface.short_description.length <= 64);
});

test('identical reinstall is a no-op and preserves unrelated local files', async () => {
	const config = options('repeat');
	await installSkill(config);
	const file = path.join(config.destination, 'SKILL.md');
	const timestamp = (await stat(file)).mtimeMs;
	await writeFile(path.join(config.destination, 'personal.txt'), 'Keep me.');
	assert.equal((await installSkill(config)).status, 'already-installed');
	assert.equal((await stat(file)).mtimeMs, timestamp);
	assert.equal(await readFile(path.join(config.destination, 'personal.txt'), 'utf8'), 'Keep me.');
});

test('modified or partial installation is refused without changing files', async () => {
	const config = options('modified');
	await installSkill(config);
	const file = path.join(config.destination, 'SKILL.md');
	const originalRuntime = await readFile(path.join(config.destination, 'runtime.json'));
	await writeFile(file, 'User customization');
	await assert.rejects(installSkill(config), /differs/);
	assert.equal(await readFile(file, 'utf8'), 'User customization');
	assert.deepEqual(await readFile(path.join(config.destination, 'runtime.json')), originalRuntime);
	const partial = options('partial');
	await mkdir(partial.destination, { recursive: true });
	await writeFile(path.join(partial.destination, 'SKILL.md'), 'Existing skill');
	await assert.rejects(installSkill(partial), /incomplete/);
	assert.deepEqual(await readdir(partial.destination), ['SKILL.md']);
});

test('linked destination and linked parents are refused without writing through them', async () => {
	const target = path.join(directory, 'link-target');
	await mkdir(target);
	for (const position of ['parent', 'destination']) {
		const config = options(`link-${position}`);
		const link = position === 'parent' ? path.dirname(config.destination) : config.destination;
		await mkdir(path.dirname(link), { recursive: true });
		await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
		await assert.rejects(installSkill(config), /plain directory/);
		assert.deepEqual(await readdir(target), []);
	}
});

test('installer CLI returns structured dry-run and failure results', async () => {
	const config = options('cli');
	const { stdout } = await exec(process.execPath, ['scripts/install-paper-skill.mjs', '--skills-dir', path.dirname(config.destination), '--dry-run'], { cwd: root });
	assert.equal(JSON.parse(stdout).status, 'would-install');
	await assert.rejects(exec(process.execPath, ['scripts/install-paper-skill.mjs', '--overwrite'], { cwd: root }), error => {
		assert.equal(error.code, 1);
		assert.equal(JSON.parse(error.stdout).status, 'failed');
		return true;
	});
});
