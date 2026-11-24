// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import browser from '../utils/browser-polyfill';
import { authorizePaperDirectory, choosePaperDirectory, getPaperDirectory, PaperDirectoryError, savePaperDirectory, WritableDirectory } from '../utils/paper-directory';
import { reportPaperDirectorySave, takePaperDirectorySave } from '../utils/paper-directory-handoff';
import { createImageArchive, ImageArchiveError } from '../utils/image-archive';
import { saveNewPaperFile } from '../utils/paper-file-writer';
import { addHistoryEntry, incrementStat } from '../utils/storage-utils';
import { unassessedManualExportChecks } from '../utils/manual-export-report';

vi.mock('../utils/storage-utils', () => ({ addHistoryEntry: vi.fn(), incrementStat: vi.fn() }));
vi.mock('lucide', () => ({ createIcons: vi.fn(), FolderOpen: {}, RotateCw: {}, CopyPlus: {}, Check: {}, X: {} }));
vi.mock('../utils/i18n', () => ({ getMessage: (key: string, detail?: string) => `${key}${detail ? ': ' + detail : ''}`,
	translatePage: vi.fn(), setupLanguageAndDirection: vi.fn() }));
vi.mock('../utils/browser-polyfill', () => ({ default: { tabs: { getCurrent: vi.fn(), update: vi.fn() } } }));
vi.mock('../utils/paper-directory', async importOriginal => ({ ...await importOriginal<typeof import('../utils/paper-directory')>(),
	authorizePaperDirectory: vi.fn(), choosePaperDirectory: vi.fn(), getPaperDirectory: vi.fn(), savePaperDirectory: vi.fn() }));
vi.mock('../utils/paper-directory-handoff', () => ({ reportPaperDirectorySave: vi.fn(), takePaperDirectorySave: vi.fn() }));
vi.mock('../utils/image-archive', async importOriginal => ({ ...await importOriginal<typeof import('../utils/image-archive')>(), createImageArchive: vi.fn() }));
vi.mock('../utils/paper-file-writer', async original => ({ ...await original<typeof import('../utils/paper-file-writer')>(), saveNewPaperFile: vi.fn() }));

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
	vi.mocked(savePaperDirectory).mockResolvedValue({ folder: 'paper-folder', checks: unassessedManualExportChecks() });
	vi.mocked(saveNewPaperFile).mockImplementation(async (_handle, name) => name);
	vi.mocked(createImageArchive).mockResolvedValue({ bytes: new Uint8Array([1]), fileName: 'paper.zip', imageCount: 1 } as Awaited<ReturnType<typeof createImageArchive>>);
	vi.mocked(takePaperDirectorySave).mockResolvedValue({ title: 'Edited title', markdown: 'Edited source', source: '', identity: { doi: null, published: null } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('stays in the background until all writes finish, then reports success before closing', async () => {
	let complete!: (value: Awaited<ReturnType<typeof savePaperDirectory>>) => void;
	vi.mocked(savePaperDirectory).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
	await import('./paper-save');
	await vi.waitFor(() => expect(savePaperDirectory).toHaveBeenCalledOnce());
	expect(browser.tabs.update).not.toHaveBeenCalled();
	expect(close).not.toHaveBeenCalled();
	complete({ folder: 'paper-folder', checks: unassessedManualExportChecks() });
	await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
	expect(addHistoryEntry).toHaveBeenCalledWith('directory', '', 'Edited title');
	expect(reportPaperDirectorySave).toHaveBeenLastCalledWith('job', { state: 'saved', message: 'paperDirectorySaved: Papers/paper-folder\nmanualChecksUnassessed' }, '');
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
	expect(reportPaperDirectorySave).toHaveBeenLastCalledWith('job', { state: 'failed', message: `paperDirectoryError_${reason}: paper-folder` }, '');
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

const zipInput = { format: 'zip' as const, title: 'Edited title', markdown: 'Edited source', source: '', identity: { doi: '10.1234/test', published: '2026-10-15' } };
it.each(['download', 'blocked', 'unsupported', 'limit'] as const)('reports attachment %s failures without publishing, with network-only retry', async reason => {
	const { AttachmentError } = await import('../utils/paper-attachments');
	const attachments = [{ url: 'https://example.org/supplement.pdf', label: 'Supplement' }];
	vi.mocked(takePaperDirectorySave).mockResolvedValue({ ...zipInput, attachments });
	vi.mocked(createImageArchive).mockRejectedValueOnce(new AttachmentError(reason, 1));
	await import('./paper-save');
	await vi.waitFor(() => expect(status().textContent).toBe(`paperAttachmentsError_${reason}: 1`));
	expect(saveNewPaperFile).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
	expect(retry().hidden).toBe(reason !== 'download');
	expect(vi.mocked(createImageArchive).mock.calls[0][8]).toEqual(attachments);
});
it.each(['zip', 'markdown'] as const)('uses the chosen directory for %s only after authorization', async format => {
	vi.mocked(takePaperDirectorySave).mockResolvedValue({ ...zipInput, format, destination: 'once' });
	await import('./paper-save');
	await vi.waitFor(() => expect(authorize().hidden).toBe(false));
	expect(getPaperDirectory).not.toHaveBeenCalled();
	expect(saveNewPaperFile).not.toHaveBeenCalled();
	authorize().click();
	await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
	expect(choosePaperDirectory).toHaveBeenCalledWith('once');
	expect(saveNewPaperFile).toHaveBeenCalledWith(handle, format === 'zip' ? 'paper.zip' : 'Edited title.md',
		format === 'zip' ? new Uint8Array([1]) : 'Edited source');
	if (format === 'markdown') {
		expect(incrementStat).toHaveBeenCalledWith('markdown', undefined, undefined, '', 'Edited title');
		expect(createImageArchive).not.toHaveBeenCalled();
	} else expect(addHistoryEntry).toHaveBeenCalledWith('zip', '', 'Edited title');
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

it('opens a one-time picker on click, allows cancellation and never reads the saved default', async () => {
	const draft = { format: 'directory' as const, destination: 'once' as const, title: 'Chosen paper', markdown: 'Edited', source: '', identity: { doi: null, published: null } };
	vi.mocked(takePaperDirectorySave).mockResolvedValue(draft);
	vi.mocked(choosePaperDirectory).mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError'));
	await import('./paper-save');
	await vi.waitFor(() => expect(authorize().hidden).toBe(false));
	expect(getPaperDirectory).not.toHaveBeenCalled();
	expect(choosePaperDirectory).not.toHaveBeenCalled();
	authorize().click();
	await vi.waitFor(() => expect(status().textContent).toBe('paperDirectoryCancelled'));
	expect(savePaperDirectory).not.toHaveBeenCalled();
	authorize().click();
	await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
	expect(choosePaperDirectory).toHaveBeenLastCalledWith('once');
	expect(savePaperDirectory).toHaveBeenCalledWith(handle, draft, expect.any(Function), { newVersion: false });
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

it.each(['directory', 'zip'] as const)('keeps a completed %s with content differences visible, without offering a second save', async format => {
	const checks = unassessedManualExportChecks();
	checks.preservation = 'attention-required';
	checks.stages.output.captions = { status: 'failed', scope: 'captions', expected: 3, matched: 2, issues: [] };
	vi.mocked(takePaperDirectorySave).mockResolvedValue({ ...zipInput, format });
	vi.mocked(savePaperDirectory).mockResolvedValue({ folder: 'paper-folder', checks });
	vi.mocked(createImageArchive).mockResolvedValue({ bytes: new Uint8Array([1]), fileName: 'paper.zip', imageCount: 0, checks });
	await import('./paper-save');
	await vi.waitFor(() => expect(browser.tabs.update).toHaveBeenCalledWith(42, { active: true }));
	expect(close).not.toHaveBeenCalled();
	expect(status().dataset.warning).toBe('true');
	expect(status().dataset.error).toBe('false');
	expect(status().textContent).toContain('paperSaveKind_captions');
	expect(status().textContent).toContain('paperSaveDifferenceIntent');
	expect(reportPaperDirectorySave).toHaveBeenLastCalledWith('job', { state: 'saved-warning', message: status().textContent }, '');
	expect(retry().hidden).toBe(true);
	expect(authorize().hidden).toBe(true);
});

it('shows image fallback independently of preservation and does not claim missing coverage passed', async () => {
	const checks = unassessedManualExportChecks();
	checks.images = { status: 'passed', scope: 'test', downloaded: 2, originalFallbacks: 1 };
	vi.mocked(savePaperDirectory).mockResolvedValue({ folder: 'paper-folder', checks });
	await import('./paper-save');
	await vi.waitFor(() => expect(browser.tabs.update).toHaveBeenCalled());
	expect(status().textContent).toContain('paperSaveImageFallback: 1');
	expect(status().textContent).toContain('manualChecksUnassessed');
	expect(close).not.toHaveBeenCalled();
});

it('keeps an existing DOI archive without writing or claiming a new save succeeded', async () => {
	vi.mocked(savePaperDirectory).mockRejectedValue(new PaperDirectoryError('duplicate', 'Original folder'));
	await import('./paper-save');
	const keep = document.getElementById('keep-existing') as HTMLButtonElement;
	await vi.waitFor(() => { expect(keep.hidden).toBe(false); expect(keep.disabled).toBe(false); });
	keep.click();
	await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
	expect(savePaperDirectory).toHaveBeenCalledOnce();
	expect(addHistoryEntry).not.toHaveBeenCalled();
	expect(reportPaperDirectorySave).toHaveBeenLastCalledWith('job', { state: 'skipped', message: 'paperDirectoryKept: Original folder' }, '');
});

it('creates a new version only on an explicit click, reusing the original snapshot', async () => {
	vi.mocked(savePaperDirectory).mockRejectedValueOnce(new PaperDirectoryError('duplicate', 'Original folder'));
	await import('./paper-save');
	const version = document.getElementById('save-new-version') as HTMLButtonElement;
	await vi.waitFor(() => { expect(version.hidden).toBe(false); expect(version.disabled).toBe(false); });
	expect(savePaperDirectory).toHaveBeenCalledOnce();
	version.click(); version.click();
	await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
	expect(savePaperDirectory).toHaveBeenCalledTimes(2);
	const calls = vi.mocked(savePaperDirectory).mock.calls;
	expect(calls[0][3]).toEqual({ newVersion: false });
	expect(calls[1][3]).toEqual({ newVersion: true });
	expect(calls[0][1]).toBe(calls[1][1]);
});
