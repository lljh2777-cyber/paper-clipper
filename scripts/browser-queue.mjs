import { createServer } from 'node:http';
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';
import { access, lstat, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
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
Keep your browser open; the paired extension runs in the background. Login/challenges require human action.
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
      --show-pairing-key Print the private key explicitly; without tasks, read only
  -h, --help             Show help

Accepts 1-20 tasks. The local service stays open until Ctrl+C; it does not install
a background service. Pairing key is private local data; never share or commit it.
Use the same output directory and port to reuse pairing. Keep them outside Vaults.
Dedicated browser remains available via save-paper.mjs --fetch browser.
`;

export function parseOptions(args) {
	const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
		'output-dir': { type: 'string', short: 'o' }, port: { type: 'string', default: '43127' },
		vault: { type: 'string' }, 'papers-dir': { type: 'string' }, template: { type: 'string', short: 't' },
		'download-assets': { type: 'boolean', default: false }, 'min-words': { type: 'string', default: '1000' },
		'require-section': { type: 'string', multiple: true, default: [] }, timeout: { type: 'string', default: '60000' },
		help: { type: 'boolean', short: 'h' },
		'show-pairing-key': { type: 'boolean', default: false },
	} });
	if (values.help) return { help: true };
	const outputDir = path.resolve(values['output-dir'] ?? path.join(root, 'output/browser-queue'));
	if (!positionals.length && values['show-pairing-key']) {
		if (tokens.some(token => token.kind === 'option' && !['show-pairing-key', 'output-dir'].includes(token.name))) throw new Error('Key viewing accepts only --output-dir.');
		return { showKeyOnly: true, outputDir };
	}
	if (!positionals.length || positionals.length > 20) throw new Error('Provide 1-20 paper identifiers.');
	positionals.forEach(classifyQuery);
	const port = Number(values.port);
	if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024-65535.');
	const forward = ['--output-dir', outputDir];
	for (const name of ['vault', 'papers-dir', 'template', 'download-assets', 'min-words', 'require-section', 'timeout']) {
		const value = values[name];
		if (value === true) forward.push(`--${name}`);
		else if (Array.isArray(value)) for (const item of value) forward.push(`--${name}`, item);
		else if (typeof value === 'string') forward.push(`--${name}`, value);
	}
	clipOptions(['sample.html', ...forward]);
	return { queries: positionals, port, outputDir, forward, showPairingKey: values['show-pairing-key'] };
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
	return readPairingKey(directory);
}

export async function readPairingKey(directory) {
	await plainDirectory(directory);
	const file = path.join(directory, 'pairing-key.txt');
	const stat = await lstat(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 64) throw new Error('Pairing key must be a regular 64-byte file.');
	const key = await readFile(file, 'utf8');
	if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid pairing key.');
	return key;
}

async function body(request, limit = maxBody) {
	if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new Error('JSON required.');
	let size = 0; const chunks = [];
	for await (const chunk of request) {
		size += chunk.length;
		if (size > limit) throw new Error('Request too large.');
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Approval is deliberately a local function, not an HTTP endpoint.
export function pairingHandshake({ onRequest, now = Date.now } = {}) {
	let pending, lastRequest = -Infinity;
	const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
	const validate = (data, origin) => {
		if (!data || typeof data.extensionId !== 'string' || typeof data.nonce !== 'string' || !/^[a-p]{32}$/.test(data.extensionId) || !/^[a-f0-9]{64}$/.test(data.nonce)) fail(400, 'Invalid pairing request.');
		if (origin && origin !== `chrome-extension://${data.extensionId}`) fail(403, 'Pairing origin mismatch.');
		if (pending && now() >= pending.expiresAt) pending = undefined;
	};
	const matches = data => pending?.extensionId === data.extensionId && timingSafeEqual(Buffer.from(pending.nonce), Buffer.from(data.nonce));
	const summary = () => ({ status: pending.status, code: pending.code, expiresAt: pending.expiresAt });
	return {
		request(data, origin) {
			validate(data, origin);
			if (!onRequest) fail(503, 'Local confirmation unavailable. Start the queue in an interactive terminal, or use Advanced manual pairing.');
			if (pending) { if (matches(data)) return summary(); fail(409, 'Another pairing request is pending. Wait for it to finish or expire.'); }
			if (now() - lastRequest < 10000) fail(429, 'Wait 10 seconds before requesting pairing again.');
			lastRequest = now();
			pending = { extensionId: data.extensionId, nonce: data.nonce, code: String(randomInt(100000, 1000000)), expiresAt: now() + 120000, status: 'pending' };
			onRequest({ extensionId: pending.extensionId, code: pending.code, expiresAt: pending.expiresAt });
			return summary();
		},
		poll(data, origin, key) {
			validate(data, origin);
			if (!pending || !matches(data)) fail(410, 'Pairing request expired or no longer available. Click Connect again.');
			const result = pending.status === 'approved' ? { status: 'approved', key } : summary();
			if (pending.status !== 'pending') pending = undefined;
			return result;
		},
		confirm(code, approve = true) {
			if (!pending || pending.status !== 'pending' || now() >= pending.expiresAt || pending.code !== code) return false;
			pending.status = approve ? 'approved' : 'denied'; return true;
		},
		clear() { pending = undefined; },
	};
}

export function confirmPairingLine(line, confirm) {
	const match = /^(?:(deny) )?(\d{6})$/.exec(line.trim());
	return !!match && confirm(match[2], !match[1]);
}

// Jobs and output destinations originate only from the local command, never a web page.
export async function startQueue(options, { resolve = resolvePaper, runPaper = savePaper, log = console.log, onPairingRequest } = {}) {
	const config = clipOptions(['sample.html', ...options.forward]);
	await plainDirectory(options.outputDir);
	if (config.archive) await validateVaultDestination(config.archive, [options.outputDir]);
	await access(path.join(root, 'dist/cli.cjs'));
	await mkdir(options.outputDir, { recursive: true });
	let key = await pairingKey(options.outputDir), rotating = false;
	const pairing = pairingHandshake({ onRequest: onPairingRequest });
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
		if (request.method === 'POST' && ['/v1/pairing/request', '/v1/pairing/status'].includes(request.url)) {
			try {
				const data = await body(request, 2048);
				if (stopping || rotating) { reply(409, { error: 'Local queue is changing. Try pairing later.' }); return; }
				reply(200, request.url.endsWith('/request') ? pairing.request(data, origin) : pairing.poll(data, origin, key));
			} catch (error) { reply(error.status ?? 400, { error: error.message }); }
			return;
		}
		const credential = Buffer.from((request.headers.authorization ?? '').replace(/^Bearer /, ''));
		if (credential.length !== 64 || !timingSafeEqual(credential, Buffer.from(key))) { reply(401, { error: 'Pairing required.' }); return; }
		const authenticatedKey = key;
		try {
			if (request.method === 'GET' && request.url === '/v1/jobs') { reply(200, { jobs: jobs.map(publicJob) }); return; }
			if (request.method !== 'POST' || stopping) { reply(404, { error: 'No route.' }); return; }
			const data = await body(request);
			// Requests authenticated before a rotation cannot finish under the old key.
			if (authenticatedKey !== key) { reply(401, { error: 'Pairing changed. Re-pair this controller.' }); return; }
			if (rotating) { reply(409, { error: 'Pairing reset in progress.' }); return; }
			if (request.url === '/v1/pairing/reset') {
				if (jobs.some(job => job.status === 'processing')) { reply(409, { error: 'Wait for conversion to finish before resetting pairing.' }); return; }
				rotating = true;
				try {
					if (await readPairingKey(options.outputDir) !== key) throw new Error('Pairing file changed; restart the service before resetting.');
					const nextKey = randomBytes(32).toString('hex');
					const temporary = path.join(options.outputDir, `pairing-key-${randomUUID()}.tmp`);
					await writeFile(temporary, nextKey, { flag: 'wx', mode: 0o600 });
					await rename(temporary, path.join(options.outputDir, 'pairing-key.txt'));
					key = nextKey;
					pairing.clear();
					for (const job of jobs) {
						if (job.status === 'claimed') { job.status = 'paused'; job.error = 'Pairing reset. Resume explicitly after checking the task tab.'; }
						delete job.lease;
					}
					await persist(); log('Pairing reset. Other controllers must re-pair; key hidden.');
					reply(200, { key });
				} finally { rotating = false; }
				return;
			}
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
	return { url: `http://127.0.0.1:${server.address().port}`, get key() { return key; }, reportPath,
		confirmPairing: (code, approve) => !stopping && !rotating && pairing.confirm(code, approve),
		close: async () => { stopping = true; pairing.clear(); await new Promise(resolveClose => server.close(resolveClose)); await writes; } };
}

export function startupMessage(queue, showKey = false) {
	return `Paper browser queue: ${queue.url}\n${showKey ? `Pairing key (private): ${queue.key}` : 'Pairing key: hidden. Click Connect in Paper queue, then confirm its code in this terminal.'}\nReport: ${queue.reportPath}\nExisting pairing is remembered. Advanced manual pairing: --show-pairing-key. Ctrl+C stops the local service.`;
}

export async function main(args = process.argv.slice(2)) {
	const options = parseOptions(args);
	if (options.help) { console.log(usage); return; }
	if (options.showKeyOnly) { console.log(`Pairing key (private): ${await readPairingKey(options.outputDir)}`); return; }
	const terminal = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
	let queue;
	try {
		queue = await startQueue(options, { onPairingRequest: terminal ? ({ extensionId, code }) => {
			console.log(`\nPairing request from extension ${extensionId}\nCompare code ${code} with Paper queue. Only if they match, enter ${code} and press Enter.\nTo deny: deny ${code}. Expires in 2 minutes. No key is displayed.`);
		} : undefined });
		terminal?.on('line', line => { console.log(confirmPairingLine(line, queue.confirmPairing) ? 'Pairing decision recorded.' : 'No matching pending request. Enter its 6-digit code, or deny CODE.'); });
		console.log(startupMessage(queue, options.showPairingKey));
		await new Promise(resolve => {
			const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); terminal?.off('SIGINT', stop); resolve(); };
			process.once('SIGINT', stop); process.once('SIGTERM', stop); terminal?.once('SIGINT', stop);
		});
	} finally { terminal?.close(); await queue?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
