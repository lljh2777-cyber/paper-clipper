import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import browser from './browser-polyfill';
import { lastPaperSaveResult, openPaperDirectorySave, reportPaperDirectorySave, takePaperDirectorySave } from './paper-directory-handoff';
import { prepareManualExportChecks } from './manual-export-checks';

vi.mock('./browser-polyfill', () => ({ default: {
	storage: { session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() } },
	tabs: { create: vi.fn(), onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
	runtime: { id: 'extension', getURL: (path: string) => `chrome-extension://extension/${path}`,
		sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
} }));
const key = 'paperDirectorySaveDraft';
const input = { title: 'Edited title', markdown: 'Edited private contents', source: 'https://example.org/paper', identity: { doi: null, published: null } };
let session: Record<string, any>;
let lifecycle: EventTarget;
beforeEach(() => {
	vi.resetAllMocks(); session = {};
	lifecycle = new EventTarget();
	vi.stubGlobal('addEventListener', lifecycle.addEventListener.bind(lifecycle));
	vi.stubGlobal('removeEventListener', lifecycle.removeEventListener.bind(lifecycle));
	vi.mocked(browser.tabs.create).mockResolvedValue({ id: 42 } as browser.Tabs.Tab);
	let pending = Promise.resolve<unknown>(undefined);
	vi.stubGlobal('navigator', { locks: { request: (_name: string, callback: () => unknown) => {
		const result = pending.then(callback); pending = result.catch(() => {}); return result;
	} } });
	vi.mocked(browser.storage.session.get).mockImplementation(async name => ({ [name as string]: structuredClone(session[name as string]) }));
	vi.mocked(browser.storage.session.set).mockImplementation(async values => { Object.assign(session, structuredClone(values)); });
	vi.mocked(browser.storage.session.remove).mockImplementation(async name => { delete session[name as string]; });
});
afterEach(() => { lifecycle.dispatchEvent(new Event('pagehide')); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('hands off the exact snapshot with only an opaque identifier in the tab URL', async () => {
	const checkedInput = { ...input, checkContext: await prepareManualExportChecks(undefined, input.markdown) };
	await openPaperDirectorySave(checkedInput);
	const draft = session[key];
	expect(draft.input).toEqual(checkedInput);
	expect(draft.expires).toBeGreaterThan(Date.now());
	expect(browser.tabs.create).toHaveBeenCalledWith({ url: `chrome-extension://extension/paper-save.html#${draft.id}`, active: false });
	expect(await takePaperDirectorySave(draft.id)).toEqual(checkedInput);
	expect(session[key]).toBeUndefined();
	await expect(takePaperDirectorySave(draft.id)).rejects.toMatchObject({ reason: 'expired' });
});
it('does not consume another request on a stale or invented identifier', async () => {
	await openPaperDirectorySave(input);
	await expect(takePaperDirectorySave('wrong')).rejects.toMatchObject({ reason: 'expired' });
	expect(session[key].input).toEqual(input);
});
it('preserves the ZIP mode across a single-use handoff', async () => {
	await openPaperDirectorySave({ ...input, format: 'zip' });
	expect(await takePaperDirectorySave(session[key].id)).toEqual({ ...input, format: 'zip' });
});
it('serializes simultaneous opens and claims, so only one can win', async () => {
	const opens = await Promise.allSettled([openPaperDirectorySave(input), openPaperDirectorySave(input)]);
	expect(opens.map(value => value.status)).toEqual(['fulfilled', 'rejected']);
	expect(browser.tabs.create).toHaveBeenCalledTimes(1);
	const id = session[key].id;
	const claims = await Promise.allSettled([takePaperDirectorySave(id), takePaperDirectorySave(id)]);
	expect(claims.map(value => value.status)).toEqual(['fulfilled', 'rejected']);
});
it('expires abandoned snapshots and allows a new explicit request', async () => {
	await openPaperDirectorySave(input);
	const id = session[key].id; session[key].expires = 0;
	await expect(takePaperDirectorySave(id)).rejects.toMatchObject({ reason: 'expired' });
	expect(session[key]).toBeUndefined();
	await openPaperDirectorySave(input);
	session[key].expires = 0;
	await openPaperDirectorySave({ ...input, title: 'New snapshot' });
	expect(session[key].input.title).toBe('New snapshot');
});
it('clears a failed tab launch and never mislabels session quota errors as permissions', async () => {
	vi.mocked(browser.tabs.create).mockRejectedValueOnce(new Error('Tab unavailable'));
	await expect(openPaperDirectorySave(input)).rejects.toMatchObject({ reason: 'handoff' });
	expect(session[key]).toBeUndefined();
	vi.mocked(browser.storage.session.set).mockRejectedValueOnce(new Error('Quota exceeded'));
	await expect(openPaperDirectorySave(input)).rejects.toMatchObject({ reason: 'handoff' });
	expect(browser.tabs.create).toHaveBeenCalledTimes(1);
});

const sender = (id: string) => ({ id: 'extension', url: `chrome-extension://extension/paper-save.html#${id}` });
const message = (id: string, state = 'saved') => ({ action: 'paperDirectorySaveStatus', id, status: { state, message: 'Saved. Scoped checks only.' } });
const receive = () => {
	const calls = vi.mocked(browser.runtime.onMessage.addListener).mock.calls;
	return calls[calls.length - 1][0];
};

it('relays only the matching trusted save status, then cleans up without losing the checks warning', async () => {
	const update = vi.fn();
	const job = await openPaperDirectorySave(input, update);
	const id = session[key].id;
	const listener = receive();
	listener(message(id), { id: 'extension', url: 'https://example.org/paper' }, vi.fn());
	listener(message(id), { ...sender(id), id: 'another-extension' }, vi.fn());
	listener(message('another-job'), sender(id), vi.fn());
	listener(message(id), sender('another-job'), vi.fn());
	listener(message(id, 'invented'), sender(id), vi.fn());
	expect(update).not.toHaveBeenCalled();
	listener(message(id, 'attention'), sender(id), vi.fn());
	expect(browser.runtime.onMessage.removeListener).not.toHaveBeenCalled();
	listener(message(id), sender(id), vi.fn());
	await job.finished;
	expect(update).toHaveBeenLastCalledWith(message(id).status);
	expect(browser.runtime.onMessage.removeListener).toHaveBeenCalledWith(listener);
	expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalledTimes(1);
	listener(message(id, 'saving'), sender(id), vi.fn());
	expect(update).toHaveBeenCalledTimes(2);
});

it('does not miss completion before tabs.create resolves', async () => {
	const update = vi.fn();
	vi.mocked(browser.tabs.create).mockImplementationOnce(async () => {
		const id = session[key].id;
		receive()(message(id), sender(id), vi.fn());
		return { id: 42 } as browser.Tabs.Tab;
	});
	const job = await openPaperDirectorySave(input, update);
	await job.finished;
	expect(update).toHaveBeenCalledOnce();
});

it('reports an unconfirmed result when the save tab is manually closed, but ignores other tabs', async () => {
	const update = vi.fn();
	const job = await openPaperDirectorySave(input, update);
	const removed = vi.mocked(browser.tabs.onRemoved.addListener).mock.calls[0][0];
	const info = { windowId: 1, isWindowClosing: false };
	removed(99, info);
	expect(update).not.toHaveBeenCalled();
	removed(42, info);
	await job.finished;
	expect(update).toHaveBeenCalledWith({ state: 'closed' });
	expect(browser.runtime.onMessage.removeListener).toHaveBeenCalledOnce();
});

it('disposes observers when the editor unloads without cancelling the independent save', async () => {
	const update = vi.fn();
	const job = await openPaperDirectorySave(input, update);
	lifecycle.dispatchEvent(new Event('pagehide'));
	await job.finished;
	expect(update).not.toHaveBeenCalled();
	expect(session[key].input).toEqual(input);
	expect(browser.runtime.onMessage.removeListener).toHaveBeenCalledOnce();
});
it('retains a specific failure when its save page closes, and clears that failure once retry starts', async () => {
	for (const retrying of [false, true]) {
		const update = vi.fn();
		const job = await openPaperDirectorySave(input, update);
		const id = session[key].id;
		await takePaperDirectorySave(id);
		receive()(message(id, 'failed'), sender(id), vi.fn());
		if (retrying) receive()(message(id, 'saving'), sender(id), vi.fn());
		const calls = vi.mocked(browser.tabs.onRemoved.addListener).mock.calls;
		calls[calls.length - 1][0](42, { windowId: 1, isWindowClosing: false });
		await job.finished;
		expect(update).toHaveBeenLastCalledWith(retrying ? { state: 'closed' } : message(id, 'failed').status);
	}
});
it('keeps only the latest terminal message in session storage, even when the editor has closed', async () => {
	vi.mocked(browser.runtime.sendMessage).mockRejectedValue(new Error('Editor closed'));
	await reportPaperDirectorySave('first', { state: 'failed', message: 'Image failed; no files written.' });
	await reportPaperDirectorySave('next', { state: 'saving', message: 'In progress' });
	expect(await lastPaperSaveResult()).toBe('Image failed; no files written.');
	await reportPaperDirectorySave('next', { state: 'saved', message: 'Saved: paper.zip. Scoped checks only.' });
	expect(session.paperSaveLastResult).toEqual({ id: 'next', state: 'saved', message: 'Saved: paper.zip. Scoped checks only.' });
	expect(JSON.stringify(session)).not.toContain(input.markdown);
});

it('does not report a committed save as failed when no editor receives its notification', async () => {
	vi.mocked(browser.runtime.sendMessage).mockRejectedValueOnce(new Error('Receiving end does not exist'));
	await expect(reportPaperDirectorySave('job', { state: 'saved', message: 'Saved' })).resolves.toBeUndefined();
	expect(browser.runtime.sendMessage).toHaveBeenCalledWith({ action: 'paperDirectorySaveStatus', id: 'job', status: { state: 'saved', message: 'Saved' } });
});

it('finishes cleanup safely when an extension reload invalidates the editor runtime', async () => {
	const job = await openPaperDirectorySave(input);
	vi.mocked(browser.runtime.onMessage.removeListener).mockImplementation(() => { throw new Error('Extension context invalidated.'); });
	lifecycle.dispatchEvent(new Event('pagehide'));
	await job.finished;
	expect(session[key].input).toEqual(input);
});
