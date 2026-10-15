import browser from './browser-polyfill';

function isInvalidatedContext(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /^(?:Error: )?Extension context invalidated\.?$/.test(message);
}

export async function requestEmbeddedPanelToggle(): Promise<'toggled' | 'invalidated'> {
	try {
		if (!browser.runtime.id) return 'invalidated';
		const response = await browser.runtime.sendMessage({ action: 'getActiveTabAndToggleIframe' }) as
			{ success?: boolean; error?: string } | undefined;
		if (response?.success !== true) {
			throw new Error(response?.error || 'Embedded panel toggle was not confirmed.');
		}
		return 'toggled';
	} catch (error) {
		if (isInvalidatedContext(error)) return 'invalidated';
		throw error;
	}
}

export async function notifySidePanelState(open: boolean): Promise<void> {
	try {
		// A page can outlive the extension context that created its embedded panel.
		// Closing that old panel must not send through an invalidated runtime.
		if (!browser.runtime.id) return;
		await browser.runtime.sendMessage({ action: open ? 'sidePanelOpened' : 'sidePanelClosed' });
	} catch (error) {
		if (isInvalidatedContext(error)) return;
		console.warn('Failed to notify side panel state:', error);
	}
}
