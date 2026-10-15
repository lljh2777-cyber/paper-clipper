import { createIcons, FolderOpen, RotateCw, X } from 'lucide';
import { getMessage, setupLanguageAndDirection, translatePage } from '../utils/i18n';
import { authorizePaperDirectory, choosePaperDirectory, getPaperDirectory, paperDirectoryFailure, savePaperDirectory, WritableDirectory } from '../utils/paper-directory';
import { PaperSaveInput, reportPaperDirectorySave, takePaperDirectorySave } from '../utils/paper-directory-handoff';
import { createImageArchive, ImageArchiveError } from '../utils/image-archive';
import { authorizeZipDownload, downloadPaperZip, hasZipDownloadPermission, PaperZipDownloadError } from '../utils/paper-zip-download';
import { manualChecksMessageKey } from '../utils/manual-export-report';
import browser from '../utils/browser-polyfill';

const status = document.getElementById('save-status')!;
const authorize = document.getElementById('authorize-save') as HTMLButtonElement;
const retry = document.getElementById('retry-save') as HTMLButtonElement;
const close = document.getElementById('close-save') as HTMLButtonElement;
let directory: WritableDirectory | undefined;
let input: PaperSaveInput | undefined;
let archive: Awaited<ReturnType<typeof createImageArchive>> | undefined;
let busy = false;
const requestId = location.hash.slice(1);

async function showAttention(state: 'attention' | 'failed' = 'attention') {
	await reportPaperDirectorySave(requestId, { state, message: status.textContent ?? '' });
	if (state === 'attention' && !input) return;
	try {
		const tab = await browser.tabs.getCurrent();
		if (tab?.id !== undefined) await browser.tabs.update(tab.id, { active: true });
	} catch { /* The user may have closed the tab while it was being activated. */ }
}

function offerPermission() {
	authorize.querySelector('span')!.textContent = getMessage(input?.format === 'zip' ? 'paperZipAuthorize' : directory ? 'paperDirectoryAuthorize' : 'choosePaperDirectory');
	authorize.hidden = false;
}
async function showFailure(error: unknown) {
	const failure = paperDirectoryFailure(error);
	authorize.hidden = true;
	retry.hidden = true;
	if (error instanceof ImageArchiveError) {
		status.textContent = getMessage(`paperSaveImageError_${error.reason}`, String(error.imageNumber));
		// Image preparation precedes all filesystem/download side effects.
		retry.hidden = !input || error.reason !== 'download';
	} else if (error instanceof PaperZipDownloadError) {
		status.textContent = getMessage(`paperZipError_${error.reason}`);
		if (input && error.reason === 'permission') offerPermission();
		retry.hidden = !input || !error.retryable;
	} else {
		status.textContent = getMessage(failure.key, failure.detail);
		if (input && input.format !== 'zip' && ['paperDirectoryError_permission', 'paperDirectoryError_missing'].includes(failure.key)) offerPermission();
	}
	status.dataset.error = 'true';
	await showAttention('failed');
}
async function save() {
	authorize.hidden = true;
	retry.hidden = true;
	status.dataset.error = 'false';
	status.textContent = getMessage('paperDirectorySaving');
	void reportPaperDirectorySave(requestId, { state: 'saving', message: status.textContent });
	const progress = (done: number, total: number) => {
		status.textContent = getMessage('imageArchiveProgress', [String(done), String(total)]);
		void reportPaperDirectorySave(requestId, { state: 'saving', message: status.textContent });
	};
	if (input!.format === 'zip') {
		archive ??= await createImageArchive(input!.markdown, input!.title, input!.source, progress, input!.imageSources, input!.checkContext);
		status.textContent = getMessage('paperZipDownloading');
		void reportPaperDirectorySave(requestId, { state: 'saving', message: status.textContent });
		await downloadPaperZip(archive.bytes, archive.fileName, () => {
			status.textContent = getMessage('paperZipReview');
			void showAttention();
		});
		status.textContent = getMessage('paperZipSaved', archive.fileName) + ' ' + getMessage(manualChecksMessageKey(archive.checks));
	} else {
		document.getElementById('save-directory')!.textContent = directory!.name;
		const folder = await savePaperDirectory(directory!, input!, progress);
		status.textContent = getMessage('paperDirectorySaved', `${directory!.name}/${folder}`) + ' ' + getMessage(manualChecksMessageKey(input?.checkContext?.report));
	}
	input = undefined;
	archive = undefined;
	await reportPaperDirectorySave(requestId, { state: 'saved', message: status.textContent });
	window.close();
}
async function runSave(withPermission: boolean) {
	if (busy || !input) return;
	busy = true; authorize.disabled = true; retry.disabled = true; close.disabled = true;
	try {
		// This click is in a top-level extension document with a real user gesture.
		if (withPermission) {
			if (input.format === 'zip') await authorizeZipDownload();
			else directory = directory ? await authorizePaperDirectory(directory) : await choosePaperDirectory();
		}
		await save();
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') {
			status.textContent = getMessage('paperDirectoryCancelled');
			offerPermission();
			await showAttention('failed');
		} else await showFailure(error);
	} finally { busy = false; authorize.disabled = false; retry.disabled = false; close.disabled = false; }
}
authorize.addEventListener('click', () => { void runSave(true); });
retry.addEventListener('click', () => { void runSave(false); });
close.addEventListener('click', () => window.close());

async function initialize() {
	await translatePage();
	await setupLanguageAndDirection();
	createIcons({ icons: { FolderOpen, RotateCw, X } });
	close.title = close.ariaLabel = getMessage('close');
	if (window.top !== window) throw new Error('Save page must be top-level.');
	input = await takePaperDirectorySave(requestId);
	document.getElementById('paper-title')!.textContent = input.title;
	document.getElementById('save-heading')!.textContent = getMessage(input.format === 'zip' ? 'saveImageArchive' : 'savePaperDirectory');
	if (input.format === 'zip') {
		if (!await hasZipDownloadPermission()) {
			status.textContent = getMessage('paperZipNeedsPermission');
			offerPermission();
			await showAttention();
			return;
		}
	} else {
		directory = await getPaperDirectory();
		if (!directory || await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') {
			status.textContent = getMessage(directory ? 'paperDirectoryNeedsPermission' : 'paperDirectoryError_missing');
			document.getElementById('save-directory')!.textContent = directory?.name ?? '';
			offerPermission();
			await showAttention();
			return;
		}
	}
	await runSave(false);
}
initialize().catch(showFailure);
