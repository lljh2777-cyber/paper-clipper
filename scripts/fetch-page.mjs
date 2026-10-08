import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));

export const browserFlags = {
	profile: { type: 'string' },
	login: { type: 'boolean', default: false },
	headed: { type: 'boolean', default: false },
	'wait-for': { type: 'string' },
	timeout: { type: 'string', default: '60000' },
	settle: { type: 'string', default: '1500' },
};

export function resolveBrowserOptions(values) {
	const timeout = Number(values.timeout);
	const settle = Number(values.settle);
	if (![timeout, settle].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647)) {
		throw new Error('--timeout and --settle must be positive integer milliseconds.');
	}
	if (settle >= timeout) throw new Error('--settle must be smaller than --timeout.');
	return {
		profile: path.resolve(values.profile ?? path.join(root, '.browser-profile')),
		login: values.login,
		headless: !values.headed && !values.login,
		waitFor: values['wait-for'],
		timeout,
		settle,
	};
}

const usage = `Usage: node scripts/fetch-page.mjs <url> [options]

  -o, --output <path>       HTML output (default: output/browser-fetch/page.html)
      --profile <path>      Dedicated persistent profile (default: .browser-profile)
      --login               Open a visible browser and wait for Enter after login
      --headed              Show the browser during capture
      --wait-for <selector> Wait for a visible element before capturing
      --timeout <ms>        Timeout per navigation/readiness phase (default: 60000)
      --settle <ms>         Stable article text interval (default: 1500)
  -h, --help                Show this help

Writes a companion <output>.json report. Exit codes: 0 captured (completeness
unchecked), 1 error, 2 subscription preview captured. No Markdown is generated.
`;

export function parseOptions(args) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			...browserFlags,
			output: { type: 'string', short: 'o' },
			help: { type: 'boolean', short: 'h' },
		},
	});
	if (values.help) return { help: true };
	if (positionals.length !== 1) throw new Error('Provide exactly one HTTP(S) URL. Use --help for usage.');
	const url = new URL(positionals[0]);
	if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported.');
	return {
		...resolveBrowserOptions(values),
		url: url.href,
		output: path.resolve(values.output ?? path.join(root, 'output/browser-fetch/page.html')),
	};
}

async function waitForStableText(page, { timeout, settle }) {
	const deadline = Date.now() + timeout;
	let previous;
	let stableSince = Date.now();
	while (Date.now() < deadline) {
		const text = await page.evaluate(() => (
			document.querySelector('article') ?? document.querySelector('main') ?? document.body
		)?.innerText ?? '');
		if (text !== previous) {
			previous = text;
			stableSince = Date.now();
		}
		if (text.trim() && Date.now() - stableSince >= settle) return;
		await delay(Math.min(250, settle));
	}
	throw new Error(`Article text did not stabilize within ${timeout} ms. Try --wait-for or a longer --timeout.`);
}

async function confirmLogin(page) {
	const prompt = createInterface({ input: process.stdin, output: process.stderr });
	const controller = new AbortController();
	const abort = () => controller.abort();
	page.context().once('close', abort);
	prompt.once('close', abort);
	try {
		await prompt.question('Log in through your institution or publisher in the browser. Press Enter here when finished: ', {
			signal: controller.signal,
		});
	} finally {
		page.context().off('close', abort);
		prompt.close();
	}
}

export async function fetchPage(options) {
	const context = await chromium.launchPersistentContext(options.profile, {
		headless: options.headless,
		timeout: options.timeout,
		viewport: { width: 1440, height: 1000 },
		acceptDownloads: false,
	});
	try {
		context.setDefaultTimeout(options.timeout);
		const page = context.pages()[0] ?? await context.newPage();
		let response = await page.goto(options.url, { waitUntil: 'domcontentloaded' });
		if (options.login) {
			await confirmLogin(page);
			// Return to the requested article even if SSO ended on an account page.
			response = await page.goto(options.url, { waitUntil: 'domcontentloaded' });
		}
		if (!response?.ok()) throw new Error(`Navigation failed: HTTP ${response?.status() ?? 'unknown'} (${page.url()})`);
		if (options.waitFor) await page.locator(options.waitFor).first().waitFor({ state: 'visible' });
		await waitForStableText(page, options);
		const content = await page.evaluate(() => ({
			title: document.title,
			text: document.body.innerText,
			headings: Array.from(document.querySelectorAll('h1, h2, h3'))
				.filter(element => element.getClientRects().length)
				.map(element => element.innerText.trim()).filter(Boolean),
		}));
		const preview = /this is a preview of subscription content/i.test(content.text.replace(/\s+/g, ' '));
		return {
			html: await page.content(),
			report: {
				requestedUrl: options.url,
				url: page.url(),
				title: content.title,
				capturedAt: new Date().toISOString(),
				status: preview ? 'subscription-preview' : 'unchecked',
				pageWordCount: content.text.trim().split(/\s+/).filter(Boolean).length,
				headings: content.headings,
			},
		};
	} finally {
		await context.close();
	}
}

export async function main(args = process.argv.slice(2)) {
	const options = parseOptions(args);
	if (options.help) {
		console.log(usage);
		return 0;
	}
	if (options.login && !process.stdin.isTTY) throw new Error('--login requires an interactive terminal.');
	console.error(`Using persistent profile: ${options.profile}`);
	const { html, report } = await fetchPage(options);
	await mkdir(path.dirname(options.output), { recursive: true });
	await writeFile(options.output, html, 'utf8');
	await writeFile(`${options.output}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	console.error(`HTML: ${options.output}\nReport: ${options.output}.json\nFinal URL: ${report.url}`);
	if (report.status === 'subscription-preview') {
		console.error('Subscription preview detected. Full text was NOT verified; run --login with an authorized account.');
		return 2;
	}
	console.error('Page captured. Full-text completeness still requires comparison with the reference Markdown.');
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then(code => { process.exitCode = code; }).catch(error => {
		console.error(error.message ?? error);
		process.exitCode = 1;
	});
}
