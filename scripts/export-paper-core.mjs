import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const converter = [
	'cli.ts', 'api.ts', 'types/types.ts', 'utils/cli-utils.ts', 'utils/cli-stubs.ts',
	'utils/browser-polyfill.ts', 'utils/debug.ts', 'utils/filters.ts', 'utils/filters/markdown.ts',
	'utils/string-utils.ts', 'utils/shared.ts', 'utils/resolver.ts', 'utils/storage-utils.ts',
	'utils/template-compiler.ts', 'utils/publisher-figures.ts', 'utils/variables/selector.ts',
	'utils/variables/simple.ts', 'utils/variables/schema.ts', 'utils/variables/prompt.ts',
	'utils/variables/model.ts', 'utils/fixtures/templates/minimal.json',
];
const modules = [
	'install-paper-skill', 'resolve-paper', 'save-paper', 'fetch-page', 'clip-paper',
	'import-papers', 'watch-exports', 'clip', 'archive-papers', 'paper-assets', 'paper-captions',
	'accept-assets', 'accept-papers', 'paper-validation', 'paper-sections',
];
const extras = ['build-cli', 'paper-metadata', 'accept-math', 'accept-vault', 'accept-clip-vault'];
const documents = ['browser-fetcher', 'clip', 'import-papers', 'watch-exports', 'paper-agent', 'paper-assets', 'paper-clipper', 'vault-archive'];
export const coreFiles = [
	'LICENSE', '.gitignore',
	...converter.map(file => `src/${file}`),
	...modules.flatMap(name => [`scripts/${name}.mjs`, `scripts/${name}.test.mjs`]),
	...extras.map(name => `scripts/${name}.mjs`),
	'scripts/clip-vault.test.mjs', 'scripts/fixtures/paper-acceptance.json',
	...documents.map(name => `docs/${name}.md`),
	'skills/paper-clipper/SKILL.md', 'skills/paper-clipper/agents/openai.yaml',
];
const replacements = {
	'README.md': 'docs/core/README.md',
	'THIRD_PARTY_NOTICES.md': 'docs/core/THIRD_PARTY_NOTICES.md',
	'docs/html-export.md': 'docs/core/html-export.md',
	'docs/paper-acceptance.md': 'docs/core/paper-acceptance.md',
};
const runtimeDependencies = ['dayjs', 'defuddle', 'knap', 'linkedom', 'marked', 'mathml-to-latex',
	'mdast-util-from-markdown', 'parse5', 'playwright', 'yaml'];

export function corePackage(lock) {
	const versions = names => Object.fromEntries(names.map(name => {
		const version = lock.packages?.[`node_modules/${name}`]?.version;
		if (!version) throw new Error(`Missing locked dependency: ${name}`);
		return [name, version];
	}));
	return {
		name: 'paper-clipper-core', version: '0.1.0', private: true, license: 'MIT',
		description: 'Independent publisher HTML to Markdown acquisition and archival workflow.',
		engines: { node: '>=22.12.0' },
		scripts: {
			build: 'npm run build:cli', 'build:cli': 'node scripts/build-cli.mjs',
			paper: 'node scripts/save-paper.mjs', clip: 'node scripts/clip.mjs',
			'clip:paper': 'node scripts/clip-paper.mjs', 'clip:import': 'node scripts/import-papers.mjs',
			'clip:watch': 'node scripts/watch-exports.mjs',
			'test:inbox': 'npm run build:cli && node --test scripts/watch-exports.test.mjs',
			'clip:vault': 'node scripts/archive-papers.mjs', 'fetch:browser': 'node scripts/fetch-page.mjs',
			'install:paper-skill': 'node scripts/install-paper-skill.mjs',
			test: 'npm run build:cli && node --test scripts/*.test.mjs',
			'test:paper-skill': 'node --test scripts/install-paper-skill.test.mjs',
			'test:paper-agent': 'node --test scripts/resolve-paper.test.mjs scripts/save-paper.test.mjs',
			'test:paper': 'node --test scripts/fetch-page.test.mjs scripts/clip-paper.test.mjs',
			'test:vault': 'node --test scripts/archive-papers.test.mjs',
			'test:import': 'node --test scripts/import-papers.test.mjs',
			'test:clip': 'node --test scripts/clip.test.mjs scripts/clip-vault.test.mjs',
			'test:assets': 'node --test scripts/paper-assets.test.mjs scripts/accept-assets.test.mjs',
			'test:acceptance': 'node --test scripts/accept-papers.test.mjs scripts/paper-captions.test.mjs',
			'accept:papers': 'node scripts/accept-papers.mjs', 'accept:assets': 'node scripts/accept-assets.mjs',
			'accept:math': 'node scripts/accept-math.mjs', 'accept:vault': 'node scripts/accept-vault.mjs',
			'accept:clip-vault': 'node scripts/accept-clip-vault.mjs',
		},
		dependencies: versions(runtimeDependencies), devDependencies: versions(['esbuild']),
	};
}

async function entry(file) {
	try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function plainParents(directory) {
	const absolute = path.resolve(directory);
	let current = path.parse(absolute).root;
	for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		const info = await entry(current);
		if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Not a plain directory: ${current}`);
	}
}

export async function exportCore(destination, { dryRun = false } = {}) {
	const output = path.resolve(destination);
	await plainParents(path.dirname(output));
	if (await entry(output)) throw new Error(`Destination already exists; no files changed: ${output}`);
	const files = new Map();
	for (const [relative, source] of [...coreFiles.map(file => [file, file]), ...Object.entries(replacements)]) {
		const filename = path.join(root, source);
		await plainParents(path.dirname(filename));
		const info = await entry(filename);
		if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Missing regular source file: ${source}`);
		let content = await readFile(filename);
		if (relative.startsWith('docs/')) {
			content = Buffer.from(content.toString('utf8').replaceAll('E:\\Paper_Clipper\\obsidian-clipper', 'E:\\Paper_Clipper\\paper-clipper-core'));
		}
		files.set(relative, content);
	}
	const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
	const pkg = corePackage(lock);
	files.set('package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n'));
	// Seed npm with the existing resolution; npm install prunes unused packages.
	lock.name = pkg.name;
	lock.version = pkg.version;
	lock.packages[''] = { name: pkg.name, version: pkg.version, license: pkg.license,
		engines: pkg.engines, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies };
	files.set('package-lock.json', Buffer.from(JSON.stringify(lock, null, 2) + '\n'));
	const manifest = { schemaVersion: 1, edition: pkg.name, upstream: 'https://github.com/obsidianmd/obsidian-clipper',
		files: [...files.keys()].sort(), sourceFiles: converter.filter(file => file.endsWith('.ts')).length,
		directDependencies: Object.keys(pkg.dependencies).length + Object.keys(pkg.devDependencies).length,
		excluded: ['browser extension UI and manifests', 'brand and store assets', 'browser profiles',
			'paper captures and personal Vaults', 'installed Skill runtime', 'node_modules and build output', 'Git history'],
	};
	files.set('core-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
	if (!dryRun) {
		await mkdir(path.dirname(output), { recursive: true });
		await mkdir(output);
		for (const [relative, content] of files) {
			await mkdir(path.dirname(path.join(output, relative)), { recursive: true });
			await writeFile(path.join(output, relative), content, { flag: 'wx' });
		}
	}
	return { status: dryRun ? 'would-export' : 'exported', output, files: files.size,
		sourceFiles: manifest.sourceFiles, directDependencies: manifest.directDependencies,
		nextStep: 'In the exported directory: npm install, npm run build:cli. Install Chromium only for browser capture/tests.' };
}

export async function main(args = process.argv.slice(2)) {
	const { values } = parseArgs({ args, options: { output: { type: 'string', short: 'o' },
		'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' } } });
	if (values.help) { console.log('Usage: node scripts/export-paper-core.mjs -o <new-directory> [--dry-run]\nCopies only the reviewed core allowlist. Never overwrites or deletes files.'); return; }
	if (!values.output?.trim()) throw new Error('--output must name a new directory.');
	console.log(JSON.stringify(await exportCore(values.output, { dryRun: values['dry-run'] }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
