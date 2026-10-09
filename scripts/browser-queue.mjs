import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolvePaper, classifyQuery } from './resolve-paper.mjs';
import { savePaper } from './save-paper.mjs';
import { validateVaultDestination } from './archive-papers.mjs';
import { parseOptions as clipOptions } from './clip.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const maxBody = 31 * 1024 * 1024;
const usage = `Usage: node scripts/browser-queue.mjs <DOI|URL|title> [...] [options]

Primary interactive acquisition through the paired extension in your usual browser.
Keep the extension's Paper queue page open. Login/challenges require human action.
No daily-profile access, cookie extraction, PDF/OCR or dedicated-browser fallback.

  -o, --output-dir <dir>   Local reports/captures (default: output/browser-queue)
      --port <n>          Loopback port (default: 43127)
      --vault <dir>       Optional explicit Vault; existing notes never change
      --papers-dir <dir>  Relative Vault paper directory
      --download-assets   Opt into image requests without browser credentials
      --min-words <n>     Existing quality threshold (default: 1000)
      --require-section <heading>  Repeatable
  -t, --template <path>   Existing full-content template
      --timeout <ms>     Conversion timeout (default: 60000)
  -h, --help             Show help

Accepts 1-20 tasks. The local service stays open until Ctrl+C; it does not install
a background service. Pairing key is private local data; never share or commit it.
Use the same output directory and port to reuse pairing. Keep them outside Vaults.
Dedicated browser remains available via save-paper.mjs --fetch browser.
`;

export function parseOptions(args) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
		'output-dir': { type: 'string', short: 'o' }, port: { type: 'string', default: '43127' },
		vault: { type: 'string' }, 'papers-dir': { type: 'string' }, template: { type: 'string', short: 't' },
		'download-assets': { type: 'boolean', default: false }, 'min-words': { type: 'string', default: '1000' },
		'require-section': { type: 'string', multiple: true, default: [] }, timeout: { type: 'string', default: '60000' },
		help: { type: 'boolean', short: 'h' },
	} });
	if (values.help) return { help: true };
	if (!positionals.length || positionals.length > 20) throw new Error('Provide 1-20 paper identifiers.');
	positionals.forEach(classifyQuery);
	const port = Number(values.port);
	if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024-65535.');
	const outputDir = path.resolve(values['output-dir'] ?? path.join(root, 'output/browser-queue'));
	const forward = ['--output-dir', outputDir];
	for (const name of ['vault', 'papers-dir', 'template', 'download-assets', 'min-words', 'require-section', 'timeout']) {
		const value = values[name];
		if (value === true) forward.push(`--${name}`);
		else if (Array.isArray(value)) for (const item of value) forward.push(`--${name}`, item);
		else if (typeof value === 'string') forward.push(`--${name}`, value);
	}
	clipOptions(['sample.html', ...forward]);
	return { queries: positionals, port, outputDir, forward };
}

async function plainDirectory(directory) {
	let current = path.resolve(directory);
	while (true) {
		try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not a plain directory: ${current}`); }
		catch (error) { if (error.code !== 'ENOENT') throw error; }
		const parent = path.dirname(current); if (parent === current) break; current = parent;
	}
}

async function pairingKey(directory) {
	const file = path.join(directory, 'pairing-key.txt');
	try { await writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
	catch (error) { if (error.code !== 'EEXIST') throw error; }
	const stat = await lstat(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 64) throw new Error('Pairing key must be a regular 64-byte file.');
	const key = await readFile(file, 'utf8');
	if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid pairing key.');
	return key;
}

async function body(request) {
	if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new Error('JSON required.');
	let size = 0; const chunks = [];
	for await (const chunk of request) {
		size += chunk.length;
		if (size > maxBody) throw new Error('Request too large.');
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Jobs and output destinations originate only from the local command, never a web page.
export async function startQueue(options, { resolve = resolvePaper, runPaper = savePaper, log = console.log } = {}) {
	const config = clipOptions(['sample.html', ...options.forward]);
	await plainDirectory(options.outputDir);
	if (config.archive) await validateVaultDestination(config.archive, [options.outputDir]);
	await access(path.join(root, 'dist/cli.cjs'));
	await mkdir(options.outputDir, { recursive: true });
	const key = await pairingKey(options.outputDir);
	const runDir = await mkdtemp(path.join(options.outputDir, 'queue-'));
	const reportPath = path.join(runDir, 'report.json');
	const jobs = [];
	for (const query of options.queries) {
		const job = { id: randomUUID(), query, status: 'queued' };
		try {
			job.resolution = await resolve(query);
			if (job.resolution.status !== 'resolved') job.status = job.resolution.status;
			else { job.url = job.resolution.selected.url; job.doi = job.resolution.selected.doi; }
		} catch (error) { job.status = 'failed'; job.error = error.message; }
		jobs.push(job);
	}
	const publicJob = ({ lease, ...job }) => job;
	let writes = Promise.resolve(), stopping = false;
	const persist = () => {
		const data = JSON.stringify({ schemaVersion: 1, route: 'extension', jobs: jobs.map(publicJob) }, null, 2) + '\n';
		writes = writes.then(() => writeFile(reportPath, data));
		return writes;
	};
	await persist();
	const server = createServer(async (request, response) => {
		const origin = request.headers.origin;
		const expectedHost = `127.0.0.1:${server.address()?.port}`;
		const originAllowed = !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
		const reply = (status, data) => {
			if (response.writableEnded || response.destroyed) return;
			response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff', ...(origin && originAllowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}) });
			response.end(JSON.stringify(data));
		};
		if (request.headers.host !== expectedHost || !originAllowed) { reply(403, { error: 'Forbidden origin/host.' }); return; }
		if (request.method === 'OPTIONS') {
			response.writeHead(204, { 'Access-Control-Allow-Origin': origin ?? '', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', Vary: 'Origin' }); response.end(); return;
		}
		const credential = Buffer.from((request.headers.authorization ?? '').replace(/^Bearer /, ''));
		if (credential.length !== 64 || !timingSafeEqual(credential, Buffer.from(key))) { reply(401, { error: 'Pairing required.' }); return; }
		try {
			if (request.method === 'GET' && request.url === '/v1/jobs') { reply(200, { jobs: jobs.map(publicJob) }); return; }
			if (request.method !== 'POST' || stopping) { reply(404, { error: 'No route.' }); return; }
			const data = await body(request);
			if (request.url === '/v1/claim') {
				if (jobs.some(job => ['claimed', 'processing', 'needs-access', 'paused'].includes(job.status))) { reply(200, { job: null }); return; }
				const job = jobs.find(job => job.status === 'queued');
				if (job) { job.status = 'claimed'; job.lease = randomUUID(); await persist(); }
				reply(200, { job: job ?? null }); return;
			}
			const match = /^\/v1\/jobs\/([a-f0-9-]+)\/(capture|pause|resume|skip)$/.exec(request.url ?? '');
			const job = match && jobs.find(item => item.id === match[1]);
			if (!job) { reply(404, { error: 'Unknown task.' }); return; }
			const action = match[2];
			if (['resume', 'skip'].includes(action)) {
				if (!['claimed', 'paused', 'needs-access'].includes(job.status)) throw new Error('Task cannot be resumed/skipped in this state.');
				job.status = action === 'resume' ? 'queued' : 'cancelled'; delete job.lease;
				await persist(); reply(200, { job: publicJob(job) }); return;
			}
			if (job.status !== 'claimed' || data.lease !== job.lease) throw new Error('Stale task lease.');
			if (action === 'pause') {
				job.status = 'paused'; job.error = String(data.reason ?? 'Browser requires attention.').slice(0, 500);
				await persist(); reply(200, { job: publicJob(job) }); return;
			}
			if (typeof data.html !== 'string' || !data.html || Buffer.byteLength(data.html) > 30 * 1024 * 1024 || data.htmlBytes !== Buffer.byteLength(data.html)) throw new Error('Invalid HTML size.');
			for (const name of ['url', 'baseURI']) {
				const url = new URL(data[name]);
				if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Invalid capture URL.');
			}
			if (typeof data.title !== 'string' || data.title.length > 10000 || typeof data.capturedAt !== 'string' || !Number.isFinite(Date.parse(data.capturedAt))) throw new Error('Invalid capture metadata.');
			job.status = 'processing'; await persist();
			try {
				await plainDirectory(runDir);
				const captureDir = await mkdtemp(path.join(runDir, 'capture-'));
				const file = path.join(captureDir, `${job.id}.html`);
				await writeFile(file, data.html, { flag: 'wx', mode: 0o600 });
				await writeFile(`${file}.json`, JSON.stringify({ schemaVersion: 1, captureMethod: 'clipper-dom', sourceUrl: job.url,
					url: data.url, baseURI: data.baseURI, title: data.title, capturedAt: data.capturedAt, charset: 'UTF-8',
					htmlFile: path.basename(file), htmlBytes: data.htmlBytes, status: 'unchecked' }), { flag: 'wx', mode: 0o600 });
				job.result = await runPaper({ query: job.query, htmlPath: file, forwardArgs: options.forward,
					outputDir: options.outputDir, resolveTimeout: 15000 }, { resolve: async () => job.resolution });
				job.status = job.result.status;
				if (job.status === 'incomplete') job.status = 'paused';
			} catch (error) { job.status = 'failed'; job.error = error.message; }
			await persist(); log(`[${job.status}] ${job.query}`); reply(200, { job: publicJob(job) });
		} catch (error) { reply(400, { error: error.message }); }
	});
	server.requestTimeout = 45000;
	server.headersTimeout = 10000;
	await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolveListen); });
	return { url: `http://127.0.0.1:${server.address().port}`, key, reportPath,
		close: async () => { stopping = true; await new Promise(resolveClose => server.close(resolveClose)); await writes; } };
}

export async function main(args = process.argv.slice(2)) {
	const options = parseOptions(args);
	if (options.help) { console.log(usage); return; }
	const queue = await startQueue(options);
	console.log(`Paper browser queue: ${queue.url}\nPairing key (private): ${queue.key}\nReport: ${queue.reportPath}\nOpen Paper queue in the extension and pair once. Ctrl+C stops the local service.`);
	await new Promise(resolve => { const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); });
	await queue.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
