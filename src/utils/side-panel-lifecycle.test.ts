import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import browser from './browser-polyfill';
import { notifySidePanelState, requestEmbeddedPanelToggle } from './side-panel-lifecycle';

vi.mock('./browser-polyfill', () => ({ default: {
	runtime: { id: 'test-extension', sendMessage: vi.fn() },
} }));

beforeEach(() => {
	vi.resetAllMocks();
	Object.defineProperty(browser.runtime, 'id', { configurable: true, value: 'test-extension' });
	vi.mocked(browser.runtime.sendMessage).mockResolvedValue(undefined);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it('confirms a panel toggle only after the background reports success', async () => {
	vi.mocked(browser.runtime.sendMessage).mockResolvedValue({ success: true });
	await expect(requestEmbeddedPanelToggle()).resolves.toBe('toggled');
	expect(browser.runtime.sendMessage).toHaveBeenCalledWith({ action: 'getActiveTabAndToggleIframe' });
});

it('does not toggle through a missing runtime', async () => {
	Object.defineProperty(browser.runtime, 'id', { value: undefined });
	await expect(requestEmbeddedPanelToggle()).resolves.toBe('invalidated');
	expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
});

it.each(['getter', 'throw', 'reject'])('reports a stale panel without retrying (%s)', async mode => {
	const error = new Error('Extension context invalidated.');
	if (mode === 'getter') Object.defineProperty(browser.runtime, 'id', { get: () => { throw error; } });
	else if (mode === 'throw') vi.mocked(browser.runtime.sendMessage).mockImplementation(() => { throw error; });
	else vi.mocked(browser.runtime.sendMessage).mockRejectedValue(error);
	await expect(requestEmbeddedPanelToggle()).resolves.toBe('invalidated');
	expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(mode === 'getter' ? 0 : 1);
});

it.each([undefined, { success: false, error: 'No active tab found' }])('does not treat an unconfirmed toggle as success (%j)', async response => {
	vi.mocked(browser.runtime.sendMessage).mockResolvedValue(response);
	await expect(requestEmbeddedPanelToggle()).rejects.toThrow(response?.error || 'not confirmed');
});

it('does not suppress unrelated toggle failures', async () => {
	const error = new Error('Connection failed');
	vi.mocked(browser.runtime.sendMessage).mockRejectedValue(error);
	await expect(requestEmbeddedPanelToggle()).rejects.toBe(error);
});

it('sends the existing open and close notifications while the runtime is live', async () => {
	await notifySidePanelState(true);
	await notifySidePanelState(false);
	expect(browser.runtime.sendMessage).toHaveBeenNthCalledWith(1, { action: 'sidePanelOpened' });
	expect(browser.runtime.sendMessage).toHaveBeenNthCalledWith(2, { action: 'sidePanelClosed' });
	expect(console.warn).not.toHaveBeenCalled();
});

it('does not contact a runtime whose ID disappeared after reload', async () => {
	Object.defineProperty(browser.runtime, 'id', { value: undefined });
	await notifySidePanelState(false);
	expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
	expect(console.warn).not.toHaveBeenCalled();
});

it('handles an invalidated runtime getter without an uncaught exception', async () => {
	Object.defineProperty(browser.runtime, 'id', { get: () => { throw new Error('Extension context invalidated.'); } });
	await expect(notifySidePanelState(false)).resolves.toBeUndefined();
	expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
	expect(console.warn).not.toHaveBeenCalled();
});

it.each(['throw', 'reject'])('handles invalidation during sendMessage (%s), without retrying', async mode => {
	const error = new Error('Extension context invalidated.');
	if (mode === 'throw') vi.mocked(browser.runtime.sendMessage).mockImplementation(() => { throw error; });
	else vi.mocked(browser.runtime.sendMessage).mockRejectedValue(error);
	await expect(notifySidePanelState(false)).resolves.toBeUndefined();
	expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
	expect(console.warn).not.toHaveBeenCalled();
});

it('retains diagnostics for unrelated communication failures', async () => {
	const error = new Error('Could not establish connection. Receiving end does not exist.');
	vi.mocked(browser.runtime.sendMessage).mockRejectedValue(error);
	await expect(notifySidePanelState(true)).resolves.toBeUndefined();
	expect(console.warn).toHaveBeenCalledWith('Failed to notify side panel state:', error);
});
