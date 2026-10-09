import { beforeEach, expect, it, vi } from 'vitest';
import browser from './browser-polyfill';
import { PaperQueueController, isQueueSender } from './paper-queue-background';
import { PaperTaskTab, QueueJob } from './paper-queue-client';

vi.mock('./browser-polyfill', () => ({ default: {
	storage: { local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() }, session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() } },
	alarms: { get: vi.fn(), create: vi.fn(), clear: vi.fn() },
	runtime: { id: 'extension', getURL: (path: string) => `chrome-extension://extension/${path}` },
} }));
vi.mock('./file-utils', () => ({ saveFile: vi.fn() }));
let local: Record<string, any>, session: Record<string, any>, jobs: QueueJob[], captures: number;
const endpoint = 'http://127.0.0.1:43127', key = 'a'.repeat(64);
const tab = () => ({ snapshot: vi.fn().mockResolvedValue({ html: 'synthetic' }), owns: vi.fn().mockResolvedValue(true), reconcile: vi.fn(), finish: vi.fn(), focus: vi.fn() });
let api: ReturnType<typeof vi.fn<(route: string, data?: any) => Promise<any>>>;
beforeEach(() => {
	vi.resetAllMocks(); local = { paperQueuePairing: { endpoint, key } }; session = {}; captures = 0;
	jobs = [{ id: 'abcd', query: '10.1234/test', url: 'https://example.org/paper', status: 'queued' }];
	for (const [area, values] of [[browser.storage.local, local], [browser.storage.session, session]] as const) {
		vi.mocked(area.get).mockImplementation(async name => ({ [name as string]: structuredClone(values[name as string]) }));
		vi.mocked(area.set).mockImplementation(async data => { Object.assign(values, structuredClone(data)); });
		vi.mocked(area.remove).mockImplementation(async name => { delete values[name as string]; });
	}
	api = vi.fn(async (route: string, data?: any) => {
		if (route === '/v1/jobs') return { jobs: structuredClone(jobs) };
		if (route === '/v1/claim') { const job = jobs.find(job => job.status === 'queued'); if (job) job.status = 'claimed'; return { job: job ? { ...job, lease: 'lease' } : null }; }
		if (route.endsWith('/capture')) { captures++; jobs[0].status = 'saved'; }
		if (route.endsWith('/pause')) jobs[0].status = 'paused';
		if (route.endsWith('/resume')) jobs[0].status = 'queued';
		if (route.endsWith('/skip')) jobs[0].status = 'cancelled';
		if (route === '/v1/pairing/reset') return { key: 'b'.repeat(64) };
		return {};
	});
});
const controller = (tabs = tab()) => new PaperQueueController(tabs as unknown as PaperTaskTab, () => api);

it('runs without any view and serializes concurrent wakeups', async () => {
	const c = controller(); await Promise.all([c.wake(), c.wake(), c.wake()]);
	expect(captures).toBe(1); expect(local.paperQueuePending).toBeUndefined();
	expect((await c.status()).jobs[0].status).toBe('saved');
	await controller().wake(); expect(captures).toBe(1);
});
it('restores a claimed capture after worker loss with same-session tab ownership', async () => {
	jobs[0].status = 'claimed'; local.paperQueuePending = { jobId: 'abcd', lease: 'lease', phase: 'capturing' };
	await controller().wake(); expect(captures).toBe(1);
});
it('never adopts a tab after browser restart and pauses for explicit resume', async () => {
	jobs[0].status = 'claimed'; local.paperQueuePending = { jobId: 'abcd', lease: 'lease', phase: 'capturing' };
	const tabs = tab(); tabs.owns.mockResolvedValue(false);
	await controller(tabs).wake(); expect(captures).toBe(0); expect(jobs[0].status).toBe('paused'); expect(tabs.snapshot).not.toHaveBeenCalled();
});
it('an uncertain submission or blocked-page pause is never recaptured', async () => {
	for (const phase of ['submitting', 'pausing']) {
		jobs[0].status = 'claimed'; local.paperQueuePending = { jobId: 'abcd', lease: 'lease', phase };
		await controller().wake(); expect(jobs[0].status).toBe('paused');
	}
	expect(captures).toBe(0);
});
it('conversion response loss only reconciles status, never resubmits HTML', async () => {
	const base = api.getMockImplementation()!;
	api.mockImplementation(async (route, data) => {
		if (route.endsWith('/capture')) { captures++; jobs[0].status = 'processing'; throw new Error('Connection lost'); }
		return base(route, data);
	});
	await controller().wake(); expect(local.paperQueuePending.phase).toBe('submitting');
	await controller().wake(); expect(captures).toBe(1); expect(jobs[0].status).toBe('processing');
	jobs[0].status = 'saved'; await controller().wake(); expect(captures).toBe(1); expect(local.paperQueuePending).toBeUndefined();
});
it('blocked access persists a pause even when its first request fails', async () => {
	const tabs = tab(); tabs.snapshot.mockRejectedValue(new Error('Human login required'));
	const base = api.getMockImplementation()!; let fail = true;
	api.mockImplementation(async (route, data) => { if (route.endsWith('/pause') && fail) { fail = false; throw new Error('Offline'); } return base(route, data); });
	await controller(tabs).wake(); expect(local.paperQueuePending.phase).toBe('pausing');
	const next = tab(); await controller(next).wake(); expect(next.snapshot).not.toHaveBeenCalled(); expect(jobs[0].status).toBe('paused');
});
it('disconnect stays disabled across controller restart; reconnect recreates alarm', async () => {
	await controller().command({ op: 'disconnect' }); await controller().wake(); expect(captures).toBe(0);
	await controller().command({ op: 'connect', endpoint, key }); expect(browser.alarms.create).toHaveBeenCalledWith('paper-queue-poll', { periodInMinutes: 1 });
	await controller().wake(); expect(captures).toBe(1);
});
it('expired pairing stops polling and clears credentials', async () => {
	api.mockRejectedValue(Object.assign(new Error('Pairing required'), { status: 401 }));
	const c = controller(); await c.wake(); expect(local.paperQueuePairing).toBeUndefined(); expect(browser.alarms.clear).toHaveBeenCalled();
	expect((await c.status()).status).toBe('Re-pair required');
});
it('reset uses stored endpoint, preserves enabled state and handles uncertain results', async () => {
	local.paperQueuePairing.enabled = false;
	await controller().command({ op: 'reset', endpoint: 'http://127.0.0.1:1234' });
	expect(local.paperQueuePairing).toEqual({ endpoint, key: 'b'.repeat(64), enabled: false });
	api.mockRejectedValue(new Error('Lost reset response'));
	await expect(controller().command({ op: 'reset' })).rejects.toThrow(); expect(local.paperQueuePairing).toBeUndefined();
});
it('only the trusted queue page may send controls, not content scripts or other extensions', () => {
	expect(isQueueSender({ id: 'extension', url: 'chrome-extension://extension/paper-queue.html' })).toBe(true);
	for (const sender of [{ id: 'extension', url: 'https://example.org' }, { id: 'other', url: 'chrome-extension://extension/paper-queue.html' }, {}]) expect(isQueueSender(sender)).toBe(false);
});
