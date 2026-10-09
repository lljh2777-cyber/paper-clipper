// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import browser from './browser-polyfill';
import { PaperTaskTab, probePaperPage, queueApi, queueEndpoint } from './paper-queue-client';

vi.mock('./browser-polyfill', () => ({ default: {
	tabs: { create: vi.fn(), get: vi.fn(), remove: vi.fn(), update: vi.fn() },
	windows: { update: vi.fn() }, scripting: { executeScript: vi.fn() },
} }));
vi.mock('./file-utils', () => ({ saveFile: vi.fn() }));
const url = 'https://example.org/paper';
const job = { id: 'task', query: url, url, status: 'claimed', lease: 'lease' };
const snapshot = { html: '<html></html>', htmlBytes: 13, url, baseURI: url, title: 'Paper', capturedAt: '2026-10-09T00:00:00Z' };

beforeEach(() => {
	vi.resetAllMocks(); vi.unstubAllGlobals();
	vi.mocked(browser.tabs.create).mockResolvedValue({ id: 12 } as any);
	vi.mocked(browser.tabs.get).mockResolvedValue({ id: 12, url, status: 'complete' } as any);
	vi.mocked(browser.scripting.executeScript).mockImplementation(async details => [{ frameId: 0, result: details.func === probePaperPage ? { url, ready: true, size: 40000, blocked: false } : { snapshot } }] as any);
});

it('accepts only fixed loopback endpoints without URL credentials, paths or fragments', () => {
	for (const value of ['https://127.0.0.1:43127', 'http://localhost:43127', 'http://127.0.0.1:43127/private', 'http://127.0.0.1:43127#key', 'http://u:p@127.0.0.1:43127', 'https://example.org']) expect(() => queueEndpoint(value)).toThrow();
	expect(queueEndpoint('http://127.0.0.1:43127/')).toBe('http://127.0.0.1:43127');
});

it('sends a bearer token only to the loopback service, never browser cookies or redirect credentials', async () => {
	const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jobs: [] }) }); vi.stubGlobal('fetch', fetchMock);
	await queueApi('http://127.0.0.1:43127', 'a'.repeat(64))('/v1/jobs');
	expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:43127/v1/jobs', expect.objectContaining({ credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${'a'.repeat(64)}` } }));
});

it('preserves authentication and conflict status for safe pairing recovery', async () => {
	for (const status of [401, 409]) {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({ error: 'Pairing recovery required' }) }));
		await expect(queueApi('http://127.0.0.1:43127', 'a'.repeat(64))('/v1/pairing/reset', {})).rejects.toMatchObject({ status, message: 'Pairing recovery required' });
	}
});

it('creates only its task tab, waits for stable content and closes that tab after acceptance', async () => {
	const worker = new PaperTaskTab(async () => {});
	expect(await worker.snapshot(job)).toEqual(snapshot);
	expect(browser.tabs.create).toHaveBeenCalledWith({ url, active: false });
	expect(browser.scripting.executeScript).toHaveBeenCalledTimes(5);
	await worker.finish(job.id);
	expect(browser.tabs.remove).toHaveBeenCalledWith(12);
});

it('never closes a task tab the user navigated elsewhere', async () => {
	const worker = new PaperTaskTab(async () => {}); await worker.snapshot(job);
	vi.mocked(browser.tabs.get).mockResolvedValue({ id: 12, url: 'https://example.org/personal' } as any);
	await worker.finish(job.id); expect(browser.tabs.remove).not.toHaveBeenCalled();
});

it('a new command releases the previous owned task without adopting unrelated tabs', async () => {
	const worker = new PaperTaskTab(async () => {}); await worker.snapshot(job);
	await worker.reconcile(['next-task']);
	expect(browser.tabs.remove).toHaveBeenCalledWith(12);
	await worker.snapshot({ ...job, id: 'next-task' });
	expect(browser.tabs.create).toHaveBeenCalledTimes(2);
});

it('pauses on challenges without capturing or closing the human-login tab', async () => {
	vi.mocked(browser.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { url, ready: true, size: 100, blocked: true } }] as any);
	const worker = new PaperTaskTab(async () => {});
	await expect(worker.snapshot(job)).rejects.toThrow('requires your attention');
	expect(browser.scripting.executeScript).toHaveBeenCalledTimes(1); expect(browser.tabs.remove).not.toHaveBeenCalled();
});

it('explicit resume reuses its tab, and recreates only if the user closed it', async () => {
	const worker = new PaperTaskTab(async () => {}); await worker.snapshot(job);
	await worker.snapshot(job); expect(browser.tabs.create).toHaveBeenCalledTimes(1);
	vi.mocked(browser.tabs.get).mockRejectedValueOnce(new Error('Closed'));
	await worker.snapshot(job); expect(browser.tabs.create).toHaveBeenCalledTimes(2);
});

it('refuses a changed page and does not claim a snapshot from a login redirect', async () => {
	vi.mocked(browser.scripting.executeScript).mockImplementation(async details => [{ frameId: 0, result: details.func === probePaperPage ? { url, ready: true, size: 40000 } : { snapshot: { ...snapshot, url: 'https://example.org/login' } } }] as any);
	await expect(new PaperTaskTab(async () => {}).snapshot(job)).rejects.toThrow('navigated');
});

it('readiness recognizes preview/challenge text, not acceptance of scientific content', () => {
	document.head.innerHTML = '<title>Just a moment</title>'; document.body.innerHTML = '<article>Preview</article>';
	expect(probePaperPage().blocked).toBe(true);
	document.title = 'Paper'; document.body.innerHTML = '<article>This is a preview of subscription content</article>';
	expect(probePaperPage().blocked).toBe(true);
});
