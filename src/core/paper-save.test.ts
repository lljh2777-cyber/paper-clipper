// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import browser from '../utils/browser-polyfill';
import { authorizePaperDirectory, choosePaperDirectory, getPaperDirectory, PaperDirectoryError, savePaperDirectory, WritableDirectory } from '../utils/paper-directory';
import { reportPaperDirectorySave, takePaperDirectorySave } from '../utils/paper-directory-handoff';
import { createImageArchive, ImageArchiveError } from '../utils/image-archive';
import { authorizeZipDownload, downloadPaperZip, hasZipDownloadPermission, PaperZipDownloadError } from '../utils/paper-zip-download';

vi.mock('lucide', () => ({ createIcons: vi.fn(), FolderOpen: {}, RotateCw: {}, X: {} }));
vi.mock('../utils/i18n', () => ({ getMessage: (key: string, detail?: string) => `${key}${detail ? ': ' + detail : ''}`,
	translatePage: vi.fn(), setupLanguageAndDirection: vi.fn() }));
vi.mock('../utils/browser-polyfill', () => ({ default: { tabs: { getCurrent: vi.fn(), update: vi.fn() } } }));
vi.mock('../utils/paper-directory', async importOriginal => ({ ...await importOriginal<typeof import('../utils/paper-directory')>(),
	authorizePaperDirectory: vi.fn(), choosePaperDirectory: vi.fn(), getPaperDirectory: vi.fn(), savePaperDirectory: vi.fn() }));
vi.mock('../utils/paper-directory-handoff', () => ({ reportPaperDirectorySave: vi.fn(), takePaperDirectorySave: vi.fn() }));
vi.mock('../utils/image-archive', async importOriginal => ({ ...await importOriginal<typeof import('../utils/image-archive')>(), createImageArchive: vi.fn() }));
vi.mock('../utils/paper-zip-download', async importOriginal => ({ ...await importOriginal<typeof import('../utils/paper-zip-download')>(),
	authorizeZipDownload: vi.fn(), downloadPaperZip: vi.fn(), hasZipDownloadPermission: vi.fn() }));

let handle: WritableDirectory;
let close = vi.fn<() => void>();
const status = () => document.getElementById('save-status')!;
const authorize = () => document.getElementById('authorize-save') as HTMLButtonElement;
const retry = () => document.getElementById('retry-save') as HTMLButtonElement;
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
	vi.mocked(hasZipDownloadPermission).mockResolvedValue(true);
	vi.mocked(createImageArchive).mockResolvedValue({ bytes: new Uint8Array([1]), fileName: 'paper.zip', imageCount: 1 } as Awaited<ReturnType<typeof createImageArchive>>);
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
	expect(retry().hidden).toBe(true);
	expect(authorize().hidden).toBe(true);
	expect(reportPaperDirectorySave).toHaveBeenLastCalledWith('job', { state: 'failed', message: `paperDirectoryError_${reason}: paper-folder` });
});

it('retries a pre-write image failure only on a click, with the original editor snapshot', async () => {
	vi.mocked(savePaperDirectory).mockRejectedValueOnce(new ImageArchiveError('download', 2));
	await import('./paper-save');
	await vi.waitFor(() => { expect(retry().hidden).toBe(false); expect(retry().disabled).toBe(false); });
	expect(status().textContent).toBe('paperSaveImageError_download: 2');
	expect(savePaperDirectory).toHaveBeenCalledOnce();
	retry().click(); retry().click();
	await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
	expect(savePaperDirectory).toHaveBeenCalledTimes(2);
	expect(vi.mocked(savePaperDirectory).mock.calls[1][1]).toBe(vi.mocked(savePaperDirectory).mock.calls[0][1]);
});

const zipInput = { format: 'zip' as const, title: 'Edited title', markdown: 'Edited source', source: '', identity: { doi: null, published: null } };
it('requests ZIP authorization only on a click and waits for download completion before closing', async () => {
	vi.mocked(takePaperDirectorySave).mockResolvedValue(zipInput);
	vi.mocked(hasZipDownloadPermission).mockResolvedValue(false);
	let complete!: () => void;
	vi.mocked(downloadPaperZip).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
	await import('./paper-save');
	await vi.waitFor(() => expect(authorize().hidden).toBe(false));
	expect(authorizeZipDownload).not.toHaveBeenCalled();
	expect(createImageArchive).not.toHaveBeenCalled();
	authorize().click();
	await vi.waitFor(() => expect(downloadPaperZip).toHaveBeenCalledOnce());
	expect(close).not.toHaveBeenCalled();
	expect(getPaperDirectory).not.toHaveBeenCalled();
	complete();
	await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
	expect(reportPaperDirectorySave).toHaveBeenLastCalledWith('job', { state: 'saved', message: 'paperZipSaved: paper.zip manualChecksUnassessed' });
});

it('keeps a denied ZIP permission actionable without preparing images', async () => {
	vi.mocked(takePaperDirectorySave).mockResolvedValue(zipInput);
	vi.mocked(hasZipDownloadPermission).mockResolvedValue(false);
	vi.mocked(authorizeZipDownload).mockRejectedValue(new PaperZipDownloadError('permission'));
	await import('./paper-save');
	await vi.waitFor(() => expect(authorize().hidden).toBe(false));
	authorize().click();
	await vi.waitFor(() => expect(status().textContent).toBe('paperZipError_permission'));
	expect(authorize().hidden).toBe(false);
	expect(createImageArchive).not.toHaveBeenCalled();
	expect(downloadPaperZip).not.toHaveBeenCalled();
});

it.each([true, false])('reuses prepared ZIP bytes only for explicitly retryable interruptions (%s)', async retryable => {
	vi.mocked(takePaperDirectorySave).mockResolvedValue(zipInput);
	vi.mocked(downloadPaperZip).mockRejectedValueOnce(new PaperZipDownloadError('interrupted', retryable));
	await import('./paper-save');
	await vi.waitFor(() => expect(status().textContent).toBe('paperZipError_interrupted'));
	expect(retry().hidden).toBe(!retryable);
	expect(close).not.toHaveBeenCalled();
	if (retryable) {
		await vi.waitFor(() => expect(retry().disabled).toBe(false));
		retry().click();
		await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
		expect(createImageArchive).toHaveBeenCalledOnce();
		expect(downloadPaperZip).toHaveBeenCalledTimes(2);
	}
});

it.each(['unsupported', 'limit'] as const)('does not offer a futile retry for an image %s failure', async reason => {
	vi.mocked(savePaperDirectory).mockRejectedValue(new ImageArchiveError(reason, 1));
	await import('./paper-save');
	await vi.waitFor(() => expect(status().textContent).toBe(`paperSaveImageError_${reason}: 1`));
	expect(retry().hidden).toBe(true);
	expect(close).not.toHaveBeenCalled();
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
