// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getPaperDirectory } from '../utils/paper-directory';
import { readArchiveCatalog } from '../utils/paper-library';

vi.mock('lucide', () => ({ createIcons: vi.fn(), Search: {}, RefreshCw: {}, FolderOpen: {} }));
vi.mock('../utils/i18n', () => ({ getMessage: (key: string) => key, setupLanguageAndDirection: vi.fn(), translatePage: vi.fn() }));
vi.mock('../utils/paper-directory', () => ({ getPaperDirectory: vi.fn() }));
vi.mock('../utils/paper-library', async original => ({ ...await original<typeof import('../utils/paper-library')>(), readArchiveCatalog: vi.fn() }));
const permission = vi.fn(), request = vi.fn(), picker = vi.fn();
const handle = { name: 'Papers', queryPermission: permission, requestPermission: request };
beforeEach(() => {
	vi.resetAllMocks(); vi.resetModules();
	document.documentElement.innerHTML = readFileSync('src/paper-library.html', 'utf8');
	vi.stubGlobal('showDirectoryPicker', picker);
	permission.mockResolvedValue('granted');
	vi.mocked(getPaperDirectory).mockResolvedValue(handle as never);
	vi.mocked(readArchiveCatalog).mockResolvedValue({ entries: [{ folder: 'one', title: '<img src=x onerror=alert(1)>', doi: '10.1234/test', year: '2026', createdAt: '', archiveStatus: 'complete', translationStatus: 'not-started' }], issues: [], skipped: 0, truncated: false });
});
afterEach(() => vi.unstubAllGlobals());

it('renders metadata as text and filters immediately without reading files again', async () => {
	await import('./paper-library');
	await vi.waitFor(() => expect(document.querySelectorAll('.archive-row')).toHaveLength(1));
	expect(document.querySelector('#library-results img')).toBeNull();
	const query = document.getElementById('library-query') as HTMLInputElement;
	query.value = 'missing'; query.dispatchEvent(new Event('input'));
	expect(document.querySelectorAll('.archive-row')).toHaveLength(0);
	query.value = '10.1234/test'; query.dispatchEvent(new Event('input'));
	expect(document.querySelectorAll('.archive-row')).toHaveLength(1);
	expect(readArchiveCatalog).toHaveBeenCalledOnce();
});

it('requests only read permission on an explicit click and clears stale results on revocation', async () => {
	permission.mockResolvedValue('prompt');
	await import('./paper-library');
	const authorize = document.getElementById('library-authorize') as HTMLButtonElement;
	await vi.waitFor(() => expect(authorize.hidden).toBe(false));
	expect(request).not.toHaveBeenCalled(); expect(readArchiveCatalog).not.toHaveBeenCalled();
	request.mockImplementation(async () => { permission.mockResolvedValue('granted'); return 'granted'; });
	authorize.click();
	await vi.waitFor(() => expect(document.querySelectorAll('.archive-row')).toHaveLength(1));
	expect(request).toHaveBeenCalledWith({ mode: 'read' });
	permission.mockResolvedValue('denied');
	(document.getElementById('library-refresh') as HTMLButtonElement).click();
	await vi.waitFor(() => expect(authorize.hidden).toBe(false));
	expect(document.querySelectorAll('.archive-row')).toHaveLength(0);
});

it('uses a read-only picker without changing the saved default directory', async () => {
	vi.mocked(getPaperDirectory).mockResolvedValue(undefined);
	picker.mockResolvedValue(handle);
	await import('./paper-library');
	await vi.waitFor(() => expect(document.getElementById('library-status')?.textContent).toBe('paperLibraryNoDirectory'));
	(document.getElementById('library-choose') as HTMLButtonElement).click();
	await vi.waitFor(() => expect(readArchiveCatalog).toHaveBeenCalledOnce());
	expect(picker).toHaveBeenCalledWith({ id: 'paper-clipper-library', mode: 'read' });
});
