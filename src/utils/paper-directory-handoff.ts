import browser from './browser-polyfill';
import { PaperDirectoryError, PaperDirectoryInput } from './paper-directory';

const key = 'paperDirectorySaveDraft';
const lock = 'paper-directory-save-draft';
const lifetime = 60_000;
type Draft = { id: string; expires: number; input: PaperDirectoryInput };

// One short-lived snapshot, in trusted extension session storage only. No article
// contents in URLs, synced storage, content-script messages or the local queue.
export async function openPaperDirectorySave(input: PaperDirectoryInput): Promise<void> {
	try {
		await navigator.locks.request(lock, async () => {
			const previous = (await browser.storage.session.get(key))[key] as Draft | undefined;
			if (previous && previous.expires > Date.now()) throw new PaperDirectoryError('busy');
			const draft: Draft = { id: crypto.randomUUID(), expires: Date.now() + lifetime, input };
			await browser.storage.session.set({ [key]: draft });
			try {
				await browser.tabs.create({ url: `${browser.runtime.getURL('paper-save.html')}#${draft.id}` });
			} catch (error) {
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
