import browser from './browser-polyfill';

export class PaperZipDownloadError extends Error {
	constructor(public readonly reason: 'permission' | 'unavailable' | 'interrupted' | 'unknown', public readonly retryable = false) { super(reason); }
}

export async function hasZipDownloadPermission(): Promise<boolean> {
	return browser.permissions.contains({ permissions: ['downloads'] });
}

export async function authorizeZipDownload(): Promise<void> {
	// Called directly from the save page's button, never from a content script.
	if (!await browser.permissions.request({ permissions: ['downloads'] })) throw new PaperZipDownloadError('permission');
}

// Only terminal, recoverable interruptions permit a new, explicitly requested
// download. Security blocks and uncertain outcomes must not be retried blindly.
const retryableInterrupts = new Set(['USER_CANCELED', 'NETWORK_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED',
	'SERVER_FAILED', 'SERVER_UNREACHABLE', 'FILE_TRANSIENT_ERROR', 'FILE_NO_SPACE']);

export async function downloadPaperZip(bytes: Uint8Array, fileName: string, needsAttention: () => void): Promise<void> {
	if (!await hasZipDownloadPermission()) throw new PaperZipDownloadError('permission');
	if (!browser.downloads?.download || !browser.downloads.onChanged) throw new PaperZipDownloadError('unavailable');
	const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: 'application/zip' }));
	try {
		await new Promise<void>((resolve, reject) => {
			let id: number | undefined;
			let settled = false;
			let attentionShown = false;
			const finish = (error?: PaperZipDownloadError) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				browser.downloads.onChanged.removeListener(changed);
				error ? reject(error) : resolve();
			};
			const inspect = async () => {
				if (settled || id === undefined) return;
				try {
					const [item] = await browser.downloads.search({ id });
					if (settled) return;
					if (!item) return finish(new PaperZipDownloadError('unknown'));
					if (item.state === 'complete') return finish();
					if (item.state === 'interrupted') return finish(new PaperZipDownloadError('interrupted', retryableInterrupts.has(item.error ?? '')));
					if (!attentionShown && (item.paused || !['safe', 'accepted'].includes(item.danger))) {
						attentionShown = true;
						needsAttention();
					}
				} catch { finish(new PaperZipDownloadError('unknown')); }
			};
			const changed = (delta: browser.Downloads.OnChangedDownloadDeltaType) => {
				if (delta.id === id) void inspect();
			};
			const timeout = setTimeout(() => finish(new PaperZipDownloadError('unknown')), 10 * 60_000);
			browser.downloads.onChanged.addListener(changed);
			// Never overwrite a previous ZIP. Listen before starting and inspect once
			// afterwards, because a small download can finish before download() returns.
			void Promise.resolve().then(() => browser.downloads.download({ url, filename: fileName, saveAs: false, conflictAction: 'uniquify' })).then(downloadId => {
				id = downloadId;
				if (typeof id !== 'number') finish(new PaperZipDownloadError('unknown'));
				else void inspect();
			}, () => finish(new PaperZipDownloadError('unknown')));
		});
	} finally { URL.revokeObjectURL(url); }
}
