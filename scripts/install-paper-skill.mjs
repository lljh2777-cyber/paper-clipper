import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(repositoryRoot, 'skills/paper-clipper');
const usage = `Usage: node scripts/install-paper-skill.mjs [options]

Install the local paper-clipper Skill, referencing this repository's pipeline.
No account upload, MCP service, dependency installation or Vault writes.

  --skills-dir <dir>  Parent skills directory (default: $CODEX_HOME/skills,
                      or ~/.codex/skills when CODEX_HOME is unset)
  --dry-run           Validate and describe without creating files/directories
  -h, --help          Show help

Only runtime.json, agents/openai.yaml and SKILL.md are installed. An identical
installation is left untouched; conflicting or partial installations are never
overwritten or deleted. Inspect and reconcile them explicitly before retrying.
The converter must already be built with npm run build:cli.
`;

export function parseOptions(args, env = process.env, home = os.homedir()) {
	const { values } = parseArgs({ args, options: { 'skills-dir': { type: 'string' },
		'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' } } });
	if (values.help) return { help: true };
	if (values['skills-dir'] !== undefined && !values['skills-dir'].trim()) throw new Error('--skills-dir cannot be empty.');
	if (!values['skills-dir'] && env.CODEX_HOME !== undefined && !env.CODEX_HOME.trim()) throw new Error('CODEX_HOME cannot be empty.');
	const parent = path.resolve(values['skills-dir'] ?? path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'skills'));
	return { destination: path.join(parent, 'paper-clipper'), dryRun: values['dry-run'] };
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
		if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error(`Not a plain directory: ${current}`);
	}
}

async function bytes(file) {
	await plainDirectories(path.dirname(file));
	const entry = await info(file);
	if (!entry?.isFile() || entry.isSymbolicLink() || entry.size > 128 * 1024) throw new Error(`Expected a bounded regular skill file: ${file}`);
	return readFile(file);
}

export async function installSkill(options) {
	const entryPoint = path.join(repositoryRoot, 'scripts/save-paper.mjs');
	for (const file of [entryPoint, path.join(repositoryRoot, 'dist/cli.cjs')]) {
		const entry = await info(file);
		if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error(`Missing regular runtime file: ${file}. Build the converter with npm run build:cli.`);
	}
	const files = new Map([
		['runtime.json', Buffer.from(JSON.stringify({ schemaVersion: 1, repositoryRoot, nodeExecutable: process.execPath, entryPoint }, null, 2) + '\n')],
		['agents/openai.yaml', await bytes(path.join(source, 'agents/openai.yaml'))],
		['SKILL.md', await bytes(path.join(source, 'SKILL.md'))],
	]);
	await plainDirectories(options.destination);
	const existing = await info(options.destination);
	if (existing) {
		for (const [relative, expected] of files) {
			let actual;
			try { actual = await bytes(path.join(options.destination, relative)); }
			catch { throw new Error(`Existing Skill is incomplete or unsafe: ${options.destination}. No files changed; inspect it manually.`); }
			if (!actual.equals(expected)) throw new Error(`Existing Skill differs at ${relative}: ${options.destination}. No files changed; reconcile it explicitly.`);
		}
	} else if (!options.dryRun) {
		await mkdir(path.dirname(options.destination), { recursive: true });
		await mkdir(options.destination);
		await mkdir(path.join(options.destination, 'agents'));
		// Publish SKILL.md last, so an incomplete copy is not discoverable as a skill.
		for (const [relative, content] of files) await writeFile(path.join(options.destination, relative), content, { flag: 'wx' });
	}
	return { schemaVersion: 1, status: existing ? 'already-installed' : options.dryRun ? 'would-install' : 'installed',
		destination: options.destination, files: [...files.keys()], repositoryRoot, dryRun: options.dryRun,
		nextStep: !existing && options.dryRun ? 'Run without --dry-run to install. No skill files were written.'
			: 'Use $paper-clipper on your next turn. Installation alone does not verify automatic skill selection.' };
}

export async function main(args = process.argv.slice(2)) {
	try {
		const options = parseOptions(args);
		if (options.help) { console.log(usage); return 0; }
		console.log(JSON.stringify(await installSkill(options), null, 2));
		return 0;
	} catch (error) {
		console.log(JSON.stringify({ schemaVersion: 1, status: 'failed', error: error.message }));
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(code => { process.exitCode = code; });
}
