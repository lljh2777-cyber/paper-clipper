import browser from './browser-polyfill';
import { PaperDirectoryError, PaperDirectoryInput } from './paper-directory';

const key = 'paperDirectorySaveDraft';
const lock = 'paper-directory-save-draft';
const lifetime = 60_000;
type Draft = { id: string; expires: number; input: PaperDirectoryInput };
const statusAction = 'paperDirectorySaveStatus';
export type PaperDirectorySaveStatus =
	| { state: 'saving' | 'attention' | 'saved'; message: string }
	| { state: 'closed' };

// Subscribe before opening the tab: even a no-image save can finish immediately.
// Only the matching, trusted save document may report an outcome.
function observeSave(id: string, onStatus: (status: PaperDirectorySaveStatus) => void) {
	let tabId: number | undefined;
	let settled = false;
	let finish!: () => void;
	const finished = new Promise<void>(resolve => { finish = resolve; });
	const dispose = () => {
		if (settled) return;
		settled = true;
		try {
			browser.runtime.onMessage.removeListener(onMessage);
			browser.tabs.onRemoved.removeListener(onRemoved);
		} catch { /* Extension reload may invalidate an editor before pagehide. */ }
		globalThis.removeEventListener('pagehide', dispose);
		finish();
	};
	const onMessage = (message: any, sender: browser.Runtime.MessageSender): undefined => {
		if (settled || sender.id !== browser.runtime.id || sender.url !== `${browser.runtime.getURL('paper-save.html')}#${id}` ||
			message?.action !== statusAction || message.id !== id ||
			!['saving', 'attention', 'saved'].includes(message.status?.state) || typeof message.status.message !== 'string') return;
		onStatus(message.status);
		if (message.status.state === 'saved') dispose();
		return undefined;
	};
	const onRemoved = (removed: number) => {
		if (settled || removed !== tabId) return;
		onStatus({ state: 'closed' });
		dispose();
	};
	browser.runtime.onMessage.addListener(onMessage);
	browser.tabs.onRemoved.addListener(onRemoved);
	globalThis.addEventListener('pagehide', dispose, { once: true });
	return { finished, dispose, setTab: (id: number | undefined) => { tabId = id; } };
}

export async function reportPaperDirectorySave(id: string, status: Exclude<PaperDirectorySaveStatus, { state: 'closed' }>): Promise<void> {
	// The editor may already have been closed. Notification is not part of the
	// filesystem transaction and must never turn a committed save into a failure.
	try { await browser.runtime.sendMessage({ action: statusAction, id, status }); } catch { /* No editor remains. */ }
}

// One short-lived snapshot, in trusted extension session storage only. No article
// contents in URLs, synced storage, content-script messages or the local queue.
export async function openPaperDirectorySave(input: PaperDirectoryInput, onStatus: (status: PaperDirectorySaveStatus) => void = () => {}): Promise<{ finished: Promise<void> }> {
	try {
		return await navigator.locks.request(lock, async () => {
			const previous = (await browser.storage.session.get(key))[key] as Draft | undefined;
			if (previous && previous.expires > Date.now()) throw new PaperDirectoryError('busy');
			const draft: Draft = { id: crypto.randomUUID(), expires: Date.now() + lifetime, input };
			await browser.storage.session.set({ [key]: draft });
			const observer = observeSave(draft.id, onStatus);
			try {
				const tab = await browser.tabs.create({ url: `${browser.runtime.getURL('paper-save.html')}#${draft.id}`, active: false });
				observer.setTab(tab.id);
				return { finished: observer.finished };
			} catch (error) {
				observer.dispose();
				await browser.storage.session.remove(key);
				throw error;
			}
		});
	} catch (error) {
		if (error instanceof PaperDirectoryError) throw error;
		throw new PaperDirectoryError('handoff');
	}
}

export async function takePaperDirectorySave(id: string): Promise<PaperDirectoryInput> {
	return navigator.locks.request(lock, async () => {
		const draft = (await browser.storage.session.get(key))[key] as Draft | undefined;
		if (!draft || draft.id !== id) throw new PaperDirectoryError('expired');
		// Consume before any filesystem work. Reload/duplicate tabs never replay a save,
		// even for a paper with no DOI. A retry must start explicitly from the editor.
		await browser.storage.session.remove(key);
		if (draft.expires <= Date.now()) throw new PaperDirectoryError('expired');
		return draft.input;
	});
}
