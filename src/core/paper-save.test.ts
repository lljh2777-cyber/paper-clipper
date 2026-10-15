// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import browser from '../utils/browser-polyfill';
import { authorizePaperDirectory, choosePaperDirectory, getPaperDirectory, PaperDirectoryError, savePaperDirectory, WritableDirectory } from '../utils/paper-directory';
import { reportPaperDirectorySave, takePaperDirectorySave } from '../utils/paper-directory-handoff';

vi.mock('lucide', () => ({ createIcons: vi.fn(), FolderOpen: {}, X: {} }));
vi.mock('../utils/i18n', () => ({ getMessage: (key: string, detail?: string) => `${key}${detail ? ': ' + detail : ''}`,
	translatePage: vi.fn(), setupLanguageAndDirection: vi.fn() }));
vi.mock('../utils/browser-polyfill', () => ({ default: { tabs: { getCurrent: vi.fn(), update: vi.fn() } } }));
vi.mock('../utils/paper-directory', async importOriginal => ({ ...await importOriginal<typeof import('../utils/paper-directory')>(),
	authorizePaperDirectory: vi.fn(), choosePaperDirectory: vi.fn(), getPaperDirectory: vi.fn(), savePaperDirectory: vi.fn() }));
vi.mock('../utils/paper-directory-handoff', () => ({ reportPaperDirectorySave: vi.fn(), takePaperDirectorySave: vi.fn() }));

let handle: WritableDirectory;
let close = vi.fn<() => void>();
const status = () => document.getElementById('save-status')!;
const authorize = () => document.getElementById('authorize-save') as HTMLButtonElement;
beforeEach(() => {
	vi.resetAllMocks(); vi.resetModules();
	document.documentElement.innerHTML = readFileSync('src/paper-save.html', 'utf8');
	vi.stubGlobal('location', { hash: '#job' });
	close = vi.fn(); vi.spyOn(window, 'close').mockImplementation(close);
	handle = { name: 'Papers', queryPermission: vi.fn().mockResolvedValue('granted') } as unknown as WritableDirectory;
	vi.mocked(browser.tabs.getCurrent).mockResolvedValue({ id: 42 } as browser.Tabs.Tab);
	vi.mocked(getPaperDirectory).mockResolvedValue(handle);
	vi.mocked(authorizePaperDirectory).mockResolvedValue(handle);
	vi.mocked(choosePaperDirectory).mockResolvedValue(handle);
	vi.mocked(savePaperDirectory).mockResolvedValue('paper-folder');
	vi.mocked(takePaperDirectorySave).mockResolvedValue({ title: 'Edited title', markdown: 'Edited source', source: '', identity: { doi: null, published: null } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('stays in the background until all writes finish, then reports success before closing', async () => {
	let complete!: (folder: string) => void;
	vi.mocked(savePaperDirectory).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
	await import('./paper-save');
	await vi.waitFor(() => expect(savePaperDirectory).toHaveBeenCalledOnce());
	expect(browser.tabs.update).not.toHaveBeenCalled();
	expect(close).not.toHaveBeenCalled();
	complete('paper-folder');
	await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
	expect(reportPaperDirectorySave).toHaveBeenLastCalledWith('job', { state: 'saved', message: 'paperDirectorySaved: Papers/paper-folder manualChecksUnassessed' });
	expect(vi.mocked(reportPaperDirectorySave).mock.invocationCallOrder.slice(-1)[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
	expect(browser.tabs.update).not.toHaveBeenCalled();
});

it('activates for permission, waits for a click, then auto-closes after authorization and saving', async () => {
	vi.mocked(handle.queryPermission).mockResolvedValue('prompt');
	await import('./paper-save');
	await vi.waitFor(() => expect(browser.tabs.update).toHaveBeenCalledWith(42, { active: true }));
	expect(authorize().hidden).toBe(false);
	expect(authorizePaperDirectory).not.toHaveBeenCalled();
	expect(savePaperDirectory).not.toHaveBeenCalled();
	expect(close).not.toHaveBeenCalled();
	authorize().click();
	await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
	expect(authorizePaperDirectory).toHaveBeenCalledWith(handle);
	expect(savePaperDirectory).toHaveBeenCalledOnce();
});

it.each(['exists', 'write'] as const)('activates and stays open on %s failure without claiming success', async reason => {
	vi.mocked(savePaperDirectory).mockRejectedValue(new PaperDirectoryError(reason, 'paper-folder'));
	await import('./paper-save');
	await vi.waitFor(() => expect(browser.tabs.update).toHaveBeenCalledWith(42, { active: true }));
	expect(status().textContent).toContain(`paperDirectoryError_${reason}`);
	expect(status().dataset.error).toBe('true');
	expect(close).not.toHaveBeenCalled();
	expect(vi.mocked(reportPaperDirectorySave).mock.calls.some(([, result]) => result.state === 'saved')).toBe(false);
});

it('retains the permission action after denial, without starting a write', async () => {
	vi.mocked(handle.queryPermission).mockResolvedValue('prompt');
	vi.mocked(authorizePaperDirectory).mockRejectedValue(new PaperDirectoryError('permission'));
	await import('./paper-save');
	await vi.waitFor(() => expect(authorize().hidden).toBe(false));
	authorize().click();
	await vi.waitFor(() => expect(status().textContent).toBe('paperDirectoryError_permission'));
	expect(authorize().hidden).toBe(false);
	expect(savePaperDirectory).not.toHaveBeenCalled();
	expect(close).not.toHaveBeenCalled();
});

it('shows the directory picker only on a click and keeps a cancelled picker available', async () => {
	vi.mocked(getPaperDirectory).mockResolvedValue(undefined);
	vi.mocked(choosePaperDirectory).mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
	await import('./paper-save');
	await vi.waitFor(() => expect(browser.tabs.update).toHaveBeenCalledWith(42, { active: true }));
	expect(choosePaperDirectory).not.toHaveBeenCalled();
	authorize().click();
	await vi.waitFor(() => expect(status().textContent).toBe('paperDirectoryCancelled'));
	expect(authorize().hidden).toBe(false);
	expect(savePaperDirectory).not.toHaveBeenCalled();
	expect(close).not.toHaveBeenCalled();
});

it('shows an expired request without replaying writes even if activating the closed tab fails', async () => {
	vi.mocked(takePaperDirectorySave).mockRejectedValue(new PaperDirectoryError('expired'));
	vi.mocked(browser.tabs.update).mockRejectedValue(new Error('Tab already closed'));
	await import('./paper-save');
	await vi.waitFor(() => expect(browser.tabs.update).toHaveBeenCalled());
	expect(status().textContent).toBe('paperDirectoryError_expired');
	expect(getPaperDirectory).not.toHaveBeenCalled();
	expect(savePaperDirectory).not.toHaveBeenCalled();
	expect(close).not.toHaveBeenCalled();
});
