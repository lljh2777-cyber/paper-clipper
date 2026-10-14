import browser from './browser-polyfill';

export async function notifySidePanelState(open: boolean): Promise<void> {
	try {
		// A page can outlive the extension context that created its embedded panel.
		// Closing that old panel must not send through an invalidated runtime.
		if (!browser.runtime.id) return;
		await browser.runtime.sendMessage({ action: open ? 'sidePanelOpened' : 'sidePanelClosed' });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/^(?:Error: )?Extension context invalidated\.?$/.test(message)) return;
		console.warn('Failed to notify side panel state:', error);
	}
}
