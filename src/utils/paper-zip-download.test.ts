import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import browser from './browser-polyfill';
import { authorizeZipDownload, downloadPaperZip } from './paper-zip-download';

vi.mock('./browser-polyfill', () => ({ default: {
	permissions: { contains: vi.fn(), request: vi.fn() },
	downloads: { download: vi.fn(), search: vi.fn(), onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
} }));
const bytes = new Uint8Array([1, 2]);
let item: { id: number; state: string; danger: string; paused?: boolean; error?: string };
const changed = () => vi.mocked(browser.downloads.onChanged.addListener).mock.calls[0][0];
beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-zip');
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
	vi.mocked(browser.permissions.contains).mockResolvedValue(true);
	vi.mocked(browser.permissions.request).mockResolvedValue(true);
	vi.mocked(browser.downloads.download).mockResolvedValue(42);
	item = { id: 42, state: 'in_progress', danger: 'safe' };
	vi.mocked(browser.downloads.search).mockImplementation(async () => [item] as browser.Downloads.DownloadItem[]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('waits for the specific download, never overwrites, and keeps the blob until completion', async () => {
	const done = vi.fn();
	const promise = downloadPaperZip(bytes, 'paper.zip', vi.fn()).then(done);
	await vi.waitFor(() => expect(browser.downloads.search).toHaveBeenCalledWith({ id: 42 }));
	expect(done).not.toHaveBeenCalled();
	expect(URL.revokeObjectURL).not.toHaveBeenCalled();
	expect(browser.downloads.download).toHaveBeenCalledWith({ url: 'blob:private-zip', filename: 'paper.zip', saveAs: false, conflictAction: 'uniquify' });
	changed()({ id: 99, state: { current: 'complete' } });
	expect(browser.downloads.search).toHaveBeenCalledOnce();
	item.state = 'complete';
	changed()({ id: 42, state: { current: 'complete' } });
	await promise;
	expect(done).toHaveBeenCalledOnce();
	expect(browser.downloads.onChanged.removeListener).toHaveBeenCalledWith(changed());
	expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-zip');
});

it('handles a download that completes before the start call returns', async () => {
	vi.mocked(browser.downloads.download).mockImplementation(async () => {
		item.state = 'complete'; changed()({ id: 42, state: { current: 'complete' } }); return 42;
	});
	await expect(downloadPaperZip(bytes, 'paper.zip', vi.fn())).resolves.toBeUndefined();
});

it.each([['NETWORK_FAILED', true], ['USER_CANCELED', true], ['FILE_VIRUS_INFECTED', false], ['SERVER_UNAUTHORIZED', false]])(
	'permits explicit retry only for a recoverable terminal interruption: %s', async (error, retryable) => {
		item.state = 'interrupted'; item.error = error as string;
		await expect(downloadPaperZip(bytes, 'paper.zip', vi.fn())).rejects.toMatchObject({ reason: 'interrupted', retryable });
		expect(browser.downloads.download).toHaveBeenCalledOnce();
		expect(browser.downloads.onChanged.removeListener).toHaveBeenCalledOnce();
	});

it('surfaces browser safety review without accepting danger or claiming completion', async () => {
	item.danger = 'file';
	const attention = vi.fn();
	const promise = downloadPaperZip(bytes, 'paper.zip', attention);
	const rejected = expect(promise).rejects.toMatchObject({ reason: 'interrupted', retryable: true });
	await vi.waitFor(() => expect(attention).toHaveBeenCalledOnce());
	expect(URL.revokeObjectURL).not.toHaveBeenCalled();
	item.state = 'interrupted'; item.error = 'USER_CANCELED';
	changed()({ id: 42, state: { current: 'interrupted' } });
	await rejected;
});

it('does not request permissions or start a download without a separate user authorization', async () => {
	vi.mocked(browser.permissions.contains).mockResolvedValue(false);
	await expect(downloadPaperZip(bytes, 'paper.zip', vi.fn())).rejects.toMatchObject({ reason: 'permission' });
	expect(browser.permissions.request).not.toHaveBeenCalled();
	expect(browser.downloads.download).not.toHaveBeenCalled();
	vi.mocked(browser.permissions.request).mockResolvedValue(false);
	await expect(authorizeZipDownload()).rejects.toMatchObject({ reason: 'permission' });
});

it('does not replay an uncertain start and cleans up listeners on synchronous API failure', async () => {
	vi.mocked(browser.downloads.download).mockImplementation(() => { throw new Error('API unavailable'); });
	await expect(downloadPaperZip(bytes, 'paper.zip', vi.fn())).rejects.toMatchObject({ reason: 'unknown', retryable: false });
	expect(browser.downloads.download).toHaveBeenCalledOnce();
	expect(browser.downloads.onChanged.removeListener).toHaveBeenCalledOnce();
	expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
});

it('does not claim success or offer retry when completion cannot be observed', async () => {
	vi.useFakeTimers();
	const promise = downloadPaperZip(bytes, 'paper.zip', vi.fn());
	const rejected = expect(promise).rejects.toMatchObject({ reason: 'unknown', retryable: false });
	await vi.advanceTimersByTimeAsync(10 * 60_000);
	await rejected;
	expect(browser.downloads.onChanged.removeListener).toHaveBeenCalledOnce();
});
