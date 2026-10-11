import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import browser from './browser-polyfill';
import { openPaperDirectorySave, takePaperDirectorySave } from './paper-directory-handoff';

vi.mock('./browser-polyfill', () => ({ default: {
	storage: { session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() } },
	tabs: { create: vi.fn() },
	runtime: { getURL: (path: string) => `chrome-extension://extension/${path}` },
} }));
const key = 'paperDirectorySaveDraft';
const input = { title: 'Edited title', markdown: 'Edited private contents', source: 'https://example.org/paper', identity: { doi: null, published: null } };
let session: Record<string, any>;
beforeEach(() => {
	vi.resetAllMocks(); session = {};
	let pending = Promise.resolve<unknown>(undefined);
	vi.stubGlobal('navigator', { locks: { request: (_name: string, callback: () => unknown) => {
		const result = pending.then(callback); pending = result.catch(() => {}); return result;
	} } });
	vi.mocked(browser.storage.session.get).mockImplementation(async name => ({ [name as string]: structuredClone(session[name as string]) }));
	vi.mocked(browser.storage.session.set).mockImplementation(async values => { Object.assign(session, structuredClone(values)); });
	vi.mocked(browser.storage.session.remove).mockImplementation(async name => { delete session[name as string]; });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('hands off the exact snapshot with only an opaque identifier in the tab URL', async () => {
	await openPaperDirectorySave(input);
	const draft = session[key];
	expect(draft.input).toEqual(input);
	expect(draft.expires).toBeGreaterThan(Date.now());
	expect(browser.tabs.create).toHaveBeenCalledWith({ url: `chrome-extension://extension/paper-save.html#${draft.id}` });
	expect(await takePaperDirectorySave(draft.id)).toEqual(input);
	expect(session[key]).toBeUndefined();
	await expect(takePaperDirectorySave(draft.id)).rejects.toMatchObject({ reason: 'expired' });
});
it('does not consume another request on a stale or invented identifier', async () => {
	await openPaperDirectorySave(input);
	await expect(takePaperDirectorySave('wrong')).rejects.toMatchObject({ reason: 'expired' });
	expect(session[key].input).toEqual(input);
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
