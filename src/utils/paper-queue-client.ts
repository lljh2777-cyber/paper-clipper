import browser from './browser-polyfill';
import { capturePageHtml, PageHtmlSnapshot } from './page-html-export';

export type QueueJob = { id: string; query: string; url?: string; doi?: string; status: string; lease?: string; error?: string;
	result?: { output?: string; error?: string; nextStep?: string; conversion?: { quality?: { completeness?: { status: string }; preservation?: { status: string }; coverage?: { status: string } } } } };

export function queueEndpoint(value: string): string {
	const url = new URL(value);
	if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use http://127.0.0.1:PORT only.');
	return url.origin;
}

export function queueApi(endpoint: string, key: string) {
	const origin = queueEndpoint(endpoint);
	if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid pairing key.');
	return async (route: string, data?: unknown) => {
		const response = await fetch(origin + route, { method: data === undefined ? 'GET' : 'POST',
			signal: AbortSignal.timeout(route.endsWith('/capture') ? 180000 : 10000),
			credentials: 'omit', redirect: 'error', cache: 'no-store',
			headers: { Authorization: `Bearer ${key}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
			body: data === undefined ? undefined : JSON.stringify(data) });
		const result = await response.json();
		if (!response.ok) throw new Error(result.error || `Queue HTTP ${response.status}`);
		return result;
	};
}

// Serialized into the task tab only. Readiness is not a content acceptance check.
export function probePaperPage() {
	const title = document.title.trim();
	const content = document.querySelector('article, main') ?? document.body;
	const text = (content?.textContent ?? '').replace(/\s+/g, ' ').trim();
	return { url: location.href, ready: document.readyState === 'complete', size: text.length,
		blocked: Array.from(document.querySelectorAll('input[type="password"]')).some(input => input.getClientRects().length > 0) ||
			/^(just a moment|access denied|attention required|client challenge|verify (you are|you're) human|security (check|verification))/i.test(title) ||
			/this is a preview of subscription content|sign in to access (?:the )?full (?:text|article)|purchase access to (?:the|this) article/i.test(text) };
}

function captureUrl(value: string, requested: string) {
	const url = new URL(value), source = new URL(requested);
	if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Unsupported task page.');
	if (url.origin !== source.origin && /^(localhost|127\.|0\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname)) throw new Error('Task redirected to a private host.');
	return url.href;
}

export class PaperTaskTab {
	private owned?: { id: number; jobId: string; capturedUrl?: string };
	constructor(private wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {}
	async snapshot(job: QueueJob): Promise<PageHtmlSnapshot> {
		if (!job.url) throw new Error('Task has no URL.');
		captureUrl(job.url, job.url);
		if (this.owned && this.owned.jobId !== job.id) throw new Error('Previous task tab still needs attention.');
		if (this.owned) { try { await browser.tabs.get(this.owned.id); } catch { this.owned = undefined; } }
		if (!this.owned) {
			const tab = await browser.tabs.create({ url: job.url, active: false });
			if (tab.id === undefined) throw new Error('Could not create a task tab.');
			this.owned = { id: tab.id, jobId: job.id };
		}
		const id = this.owned.id;
		let prior = '', stable = 0;
		for (let attempt = 0; attempt < 30; attempt++) {
			const tab = await browser.tabs.get(id);
			if (tab.status === 'complete' && tab.url && /^https?:/.test(tab.url)) {
				captureUrl(tab.url, job.url);
				this.owned.capturedUrl = tab.url;
				const probe = (await browser.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, func: probePaperPage }))[0]?.result as ReturnType<typeof probePaperPage> | undefined;
				if (probe?.blocked) throw new Error('Login, verification or full-text access requires your attention.');
				const signature = probe?.ready ? `${probe.url}:${probe.size}` : '';
				stable = signature && signature === prior ? stable + 1 : 0; prior = signature;
				if (stable >= 3) {
					const result = (await browser.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, func: capturePageHtml }))[0]?.result as { snapshot?: PageHtmlSnapshot; error?: string } | undefined;
					if (!result?.snapshot) throw new Error(result?.error ?? 'Snapshot failed.');
					if (result.snapshot.url !== probe?.url) throw new Error('Page navigated during capture.');
					this.owned.capturedUrl = result.snapshot.url;
					return result.snapshot;
				}
			}
			await this.wait(1000);
		}
		throw new Error('Page did not settle within 30 seconds. Resume explicitly after it is ready.');
	}
	async focus(jobId: string) {
		if (this.owned?.jobId !== jobId) throw new Error('No task tab owned by this queue page. Resume to create a new one.');
		const tab = await browser.tabs.update(this.owned.id, { active: true });
		if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
	}
	async reconcile(jobIds: string[]) {
		if (this.owned && !jobIds.includes(this.owned.jobId)) await this.finish(this.owned.jobId);
	}
	async finish(jobId: string) {
		if (this.owned?.jobId !== jobId) return;
		const owned = this.owned; this.owned = undefined;
		try {
			const tab = await browser.tabs.get(owned.id);
			// A tab the user navigated elsewhere is no longer ours to close.
			if (owned.capturedUrl && tab.url === owned.capturedUrl) await browser.tabs.remove(owned.id);
		} catch { /* The user may already have closed the task tab. */ }
	}
}
