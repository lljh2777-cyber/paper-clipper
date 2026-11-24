import browser from './browser-polyfill';
import { detectBrowser } from './browser-detection';

export interface SaveFileOptions {
	content: string;
	fileName: string;
	mimeType?: string;
	tabId?: number;
}

export function base64EncodeUnicode(str: string): string {
	const utf8Bytes = encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, 
		(match, p1) => String.fromCharCode(parseInt(p1, 16))
	);
	return btoa(utf8Bytes);
}

export async function saveFile({
	content,
	fileName,
	mimeType = 'text/markdown',
	tabId
}: SaveFileOptions): Promise<void> {
	if (mimeType === 'text/markdown' && !fileName.toLowerCase().endsWith('.md')) {
		fileName = `${fileName}.md`;
	}

	const browserType = await detectBrowser();
	const isSafari = ['ios', 'mobile-ios', 'ipad-os', 'safari', 'mobile-safari'].includes(browserType);

	if (isSafari) {
		const dataUri = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
		if (tabId === undefined) {
			if (navigator.share) {
				const file = new File([content], fileName, { type: mimeType });
				try {
					await navigator.share({ files: [file], text: fileName });
					return;
				} catch (error) {
					if (error instanceof Error && error.name === 'AbortError') throw error;
					// Older Safari versions may support sharing text but not files.
				}
			}
			if (!window.open(dataUri)) throw new Error('Could not open file for export');
			return;
		}

		await browser.scripting.executeScript({
			target: { tabId },
			func: (fileName: string, dataUri: string) => {
				const a = document.createElement('a');
				a.href = dataUri;
				a.download = fileName;
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
			},
			args: [fileName, dataUri]
		});
	} else {
		const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = fileName;
		document.body.appendChild(a);
		try {
			a.click();
		} finally {
			a.remove();
			URL.revokeObjectURL(url);
		}
	}
}
