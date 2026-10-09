import { access, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { clip, parseOptions as clipOptions, printResult } from './clip.mjs';
import { validateVaultDestination } from './archive-papers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const maxPairs = 2000;
const usage = `Usage: node scripts/watch-exports.mjs <inbox-directory> [options]

Watch one dedicated folder for Clipper .html / .html.json exports.
Start this command, then export from your normally logged-in browser.
Existing pairs in this explicitly selected inbox are included. No recursion.

  -o, --output-dir <dir>    Separate output directory (default: output/browser-fetch/inbox)
  -t, --template <path>     Existing full-content Clipper template
      --vault <dir>         Optional explicit Vault; existing notes never change
      --papers-dir <path>   Relative paper folder within the Vault
      --download-assets    Opt into image requests without browser credentials
      --min-words <n>       Existing body threshold (default: 1000)
      --require-section <h> Required nonempty section, repeatable
      --timeout <ms>        Existing conversion timeout (default: 60000)
      --interval <ms>       Poll interval (default: 1000)
      --settle <ms>         Both files must remain stable (default: 1500)
      --once                Two scans separated by the settle interval, then exit
  -h, --help                Show help

No HTTP server, new extension permissions, cookie access or automatic login.
No overwrite, deletion or automatic retry of an unchanged failed pair.
Results/state are under <output-dir>/_inbox; full reports use the existing pipeline.
Use a separate output directory per inbox. Do not watch your whole Downloads folder.
Ctrl+C stops after the current conversion finishes. Exit: 0 no issues, 1 failure,
2 incomplete/unresolved assets, 3 pending downloads only. A saved file is not proof
of full-text completeness. Browser download prompts may still need confirmation.
`;

function within(parent, child) {
	const relative = path.relative(parent, child);
	return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function info(file) {
	try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function plainDirectories(directory) {
	const absolute = path.resolve(directory);
	let current = path.parse(absolute).root;
	for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		const entry = await info(current);
		if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error(`Not a plain directory: ${current}`);
	}
}

export function parseOptions(args) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
		'output-dir': { type: 'string', short: 'o' }, template: { type: 'string', short: 't' },
		vault: { type: 'string' }, 'papers-dir': { type: 'string' },
		'download-assets': { type: 'boolean', default: false },
		'min-words': { type: 'string', default: '1000' }, 'require-section': { type: 'string', multiple: true, default: [] },
		timeout: { type: 'string', default: '60000' }, interval: { type: 'string', default: '1000' }, settle: { type: 'string', default: '1500' },
		once: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
	} });
	if (values.help) return { help: true };
	if (positionals.length !== 1 || !positionals[0].trim() || /^https?:/i.test(positionals[0])) throw new Error('Provide one local inbox directory.');
	const interval = Number(values.interval), settle = Number(values.settle);
	if (![interval, settle].every(value => Number.isSafeInteger(value) && value >= 100 && value <= 60000)) throw new Error('--interval and --settle must be integer milliseconds from 100 to 60000.');
	const inbox = path.resolve(positionals[0]);
	const forward = [];
	for (const name of ['template', 'vault', 'papers-dir', 'download-assets', 'min-words', 'require-section', 'timeout']) {
		const value = values[name];
		if (value === true) forward.push(`--${name}`);
		else if (typeof value === 'string') forward.push(`--${name}`, value);
		else if (Array.isArray(value)) for (const entry of value) forward.push(`--${name}`, entry);
	}
	forward.push('--output-dir', values['output-dir'] ?? path.join(root, 'output/browser-fetch/inbox'));
	const pipeline = clipOptions([inbox, ...forward]);
	for (const [left, right] of [[inbox, pipeline.outputDir], ...(pipeline.archive ? [[inbox, pipeline.archive.vault]] : [])]) {
		if (within(left, right) || within(right, left)) throw new Error('Inbox, output directory and Vault must not overlap.');
	}
	return { inbox, outputDir: pipeline.outputDir, pipeline, forward, interval, settle, once: values.once };
}

export async function createWatcher(options, { runClip = clip, now = Date.now, log = console.log } = {}) {
	await plainDirectories(options.inbox);
	if (!(await lstat(options.inbox)).isDirectory()) throw new Error('Inbox must be an existing directory.');
	await plainDirectories(options.outputDir);
	if (options.pipeline.archive) await validateVaultDestination(options.pipeline.archive, [options.inbox, options.outputDir]);
	await access(path.join(root, 'dist/cli.cjs')).catch(() => { throw new Error('Build the Clipper CLI first: npm run build:cli'); });
	if (options.pipeline.config.template) {
		const file = options.pipeline.config.template;
		const entry = await lstat(file);
		if (entry.isFile()) JSON.parse(await readFile(file, 'utf8'));
		else if (!entry.isDirectory()) throw new Error('Template must be a JSON file or directory.');
	}
	const stateDir = path.join(options.outputDir, '_inbox');
	await plainDirectories(stateDir);
	await mkdir(stateDir, { recursive: true });
	const statePath = path.join(stateDir, 'state.json');
	const lockPath = path.join(stateDir, 'watcher.lock');
	let lock;
	try { lock = await open(lockPath, 'wx'); } catch (error) {
		if (error.code === 'EEXIST') throw new Error(`Inbox watcher lock exists. Check for a running watcher; manually remove this one file only if stale: ${lockPath}`);
		throw error;
	}
	let closed = false, busy = false;
	const close = async () => {
		if (closed) return;
		if (busy) throw new Error('Wait for the current scan before closing the watcher.');
		closed = true;
		await lock.close();
		await unlink(lockPath);
	};
	try {
		await lock.writeFile(JSON.stringify({ pid: process.pid, inbox: options.inbox, startedAt: new Date().toISOString() }));
		let state = { schemaVersion: 1, inbox: options.inbox, entries: {} };
		const checkStateFile = async () => {
			const entry = await info(statePath);
			if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.size > 2 * 1024 * 1024)) throw new Error('Watcher state must be a bounded regular file.');
			return entry;
		};
		if (await checkStateFile()) {
			state = JSON.parse(await readFile(statePath, 'utf8'));
			if (state.schemaVersion !== 1 || state.inbox !== options.inbox || !state.entries || Array.isArray(state.entries) || typeof state.entries !== 'object' ||
				Object.entries(state.entries).some(([name, entry]) => path.basename(name) !== name || !/\.html$/i.test(name) || !entry || typeof entry.signature !== 'string' || !['success', 'incomplete', 'failed', 'skipped'].includes(entry.status))) {
				throw new Error('Invalid watcher state or output directory belongs to another inbox; do not reset it automatically.');
			}
		}
		const persist = async () => {
			if (Object.keys(state.entries).length > maxPairs) throw new Error(`Watcher history exceeds ${maxPairs} pairs. Use a new inbox/output pair.`);
			await plainDirectories(stateDir);
			await checkStateFile();
			const text = JSON.stringify(state, null, 2) + '\n';
			if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Watcher state exceeds 2 MiB. Use a new inbox/output pair.');
			const temporary = path.join(stateDir, `state-${randomUUID()}.tmp`);
			await writeFile(temporary, text, { flag: 'wx' });
			await rename(temporary, statePath);
		};
		const pending = new Map();
		if (Object.keys(state.entries).length > maxPairs) throw new Error('Watcher history is too large. Use a new inbox/output pair.');
		const scan = async ({ signal } = {}) => {
			if (closed || busy) throw new Error(closed ? 'Watcher is closed.' : 'A watcher scan is already running.');
			busy = true;
			const result = { processed: [], retained: [], pending: 0 };
			try {
				await plainDirectories(options.inbox);
				await plainDirectories(stateDir);
				if (options.pipeline.archive) await validateVaultDestination(options.pipeline.archive, [options.inbox, options.outputDir]);
				const names = new Set();
				for (const entry of await readdir(options.inbox, { withFileTypes: true })) {
					if (entry.isDirectory()) continue;
					if (/\.html$/i.test(entry.name)) names.add(entry.name);
					else if (/\.html\.json$/i.test(entry.name)) names.add(entry.name.slice(0, -5));
				}
				if (names.size > maxPairs) throw new Error(`Inbox exceeds ${maxPairs} pairs; use a dedicated smaller folder.`);
				for (const name of pending.keys()) if (!names.has(name)) pending.delete(name);
				for (const name of [...names].sort()) {
					if (signal?.aborted) { result.pending++; break; }
					const input = path.join(options.inbox, name);
					const files = [await info(input), await info(`${input}.json`)];
					const signature = files.map(file => file ? `${file.isFile()}:${file.isSymbolicLink()}:${file.size}:${file.mtimeMs}:${file.ctimeMs}` : 'missing').join('|');
					if (state.entries[name]?.signature === signature) {
						result.retained.push({ input, status: state.entries[name].status });
						continue;
					}
					const observed = pending.get(name);
					if (!observed || observed.signature !== signature) {
						pending.set(name, { signature, since: now() });
						log(`[${files.every(Boolean) ? 'settling' : 'waiting-pair'}] ${name}`);
						result.pending++;
						continue;
					}
					if (!files.every(Boolean) || now() - observed.since < options.settle) { result.pending++; continue; }
					if (!Object.hasOwn(state.entries, name) && Object.keys(state.entries).length >= maxPairs) throw new Error('Watcher history is full. Use a new inbox/output pair.');
					let item;
					try {
						if (files.some((file, index) => !file.isFile() || file.isSymbolicLink() || file.size > (index ? 64 * 1024 : 30 * 1024 * 1024))) throw new Error('Export pair must contain bounded regular files, not links.');
						log(`[processing] ${name}`);
						const converted = await runClip(clipOptions([input, ...options.forward]));
						printResult(converted, log);
						const paper = converted.report.items[0];
						const status = paper?.archive?.status === 'failed' ? 'failed' : paper?.assets?.failed || paper?.archive?.reason === 'incomplete-assets' ? 'incomplete' : paper?.status ?? 'failed';
						item = { status, reportPath: converted.reportPath, output: paper?.archive?.output ?? (paper?.outputWritten ? paper.output : undefined) };
					} catch (error) { item = { status: 'failed', error: error.message }; log(`[failed] ${name}: ${error.message}`); }
					state.entries[name] = { signature, ...item, finishedAt: new Date().toISOString() };
					await persist();
					pending.delete(name);
					result.processed.push({ input, ...item });
				}
				return result;
			} finally { busy = false; }
		};
		return { scan, close, statePath };
	} catch (error) { await close(); throw error; }
}

export async function main(args = process.argv.slice(2)) {
	const options = parseOptions(args);
	if (options.help) { console.log(usage); return 0; }
	const watcher = await createWatcher(options);
	const stop = new AbortController();
	const onStop = () => { console.log('Stopping after the current conversion finishes.'); stop.abort(); };
	process.once('SIGINT', onStop);
	process.once('SIGTERM', onStop);
	let failures = false, incomplete = false, pending = 0;
	const collect = result => {
		failures ||= [...result.processed, ...result.retained].some(item => item.status === 'failed');
		incomplete ||= [...result.processed, ...result.retained].some(item => item.status === 'incomplete');
		pending = result.pending;
	};
	try {
		console.log(`Watching: ${options.inbox}\nOutput: ${options.outputDir}\nState: ${watcher.statePath}\nOnly explicit image downloads may use the network. Export both files into this inbox.`);
		const initial = await watcher.scan({ signal: stop.signal });
		collect(initial);
		if (initial.retained.length) console.log(`Unchanged history (not revalidated): ${initial.retained.length}; failed: ${initial.retained.filter(item => item.status === 'failed').length}; incomplete: ${initial.retained.filter(item => item.status === 'incomplete').length}. See state and original reports.`);
		do {
			try { await delay(options.once ? options.settle : options.interval, undefined, { signal: stop.signal }); }
			catch (error) { if (error.name !== 'AbortError') throw error; break; }
			collect(await watcher.scan({ signal: stop.signal }));
		} while (!options.once && !stop.signal.aborted);
		return failures ? 1 : incomplete ? 2 : pending ? 3 : 0;
	} finally {
		process.off('SIGINT', onStop);
		process.off('SIGTERM', onStop);
		await watcher.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
