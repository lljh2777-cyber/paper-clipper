import { createIcons, FolderOpen, RotateCw, CopyPlus, Check, X } from 'lucide';
import { getMessage, setupLanguageAndDirection, translatePage } from '../utils/i18n';
import { authorizePaperDirectory, choosePaperDirectory, getPaperDirectory, paperDirectoryFailure, savePaperDirectory, WritableDirectory } from '../utils/paper-directory';
import { PaperSaveInput, reportPaperDirectorySave, takePaperDirectorySave } from '../utils/paper-directory-handoff';
import { createImageArchive, createImageDownloadSession, ImageArchiveError, type ImageDownloadSession } from '../utils/image-archive';
import { AttachmentError } from '../utils/paper-attachments';
import { saveNewPaperFile } from '../utils/paper-file-writer';
import { sanitizeFileName } from '../utils/string-utils';
import { manualChecksMessageKey, ManualExportChecks } from '../utils/manual-export-report';
import browser from '../utils/browser-polyfill';
import { addHistoryEntry, incrementStat } from '../utils/storage-utils';

const status = document.getElementById('save-status')!;
const authorize = document.getElementById('authorize-save') as HTMLButtonElement;
const retry = document.getElementById('retry-save') as HTMLButtonElement;
const close = document.getElementById('close-save') as HTMLButtonElement;
const keep = document.getElementById('keep-existing') as HTMLButtonElement;
const version = document.getElementById('save-new-version') as HTMLButtonElement;
let directory: WritableDirectory | undefined;
let input: PaperSaveInput | undefined;
let archive: Awaited<ReturnType<typeof createImageArchive>> | undefined;
let imageDownloads: ImageDownloadSession | undefined;
let busy = false;
let newVersion = false;
let existingFolder = '';
const requestId = location.hash.slice(1);

async function revealSavePage() {
	try {
		const tab = await browser.tabs.getCurrent();
		if (tab?.id !== undefined) await browser.tabs.update(tab.id, { active: true });
	} catch { /* The user may have closed the tab while it was being activated. */ }
}
async function showAttention(state: 'attention' | 'failed' = 'attention', message = status.textContent ?? '') {
	await reportPaperDirectorySave(requestId, { state, message }, input?.source);
	if (state === 'attention' && !input) return;
	await revealSavePage();
}

function checkSummary(checks?: ManualExportChecks): { warning: boolean; message: string } {
	const lines = [getMessage(manualChecksMessageKey(checks))];
	let warning = checks?.preservation === 'attention-required';
	for (const stage of ['extraction', 'template', 'output'] as const) {
		for (const kind of ['captions', 'references', 'extendedImages', 'math'] as const) {
			const check = checks?.stages[stage][kind];
			if (check?.status !== 'failed') continue;
			warning = true;
			lines.push(getMessage('paperSaveCheckDifference', [getMessage(`paperSaveStage_${stage}`), getMessage(`paperSaveKind_${kind}`), String(check.matched), String(check.expected)]));
		}
	}
	if (checks?.preservation === 'attention-required') lines.push(getMessage('paperSaveDifferenceIntent'));
	if (checks?.images?.originalFallbacks) {
		warning = true;
		lines.push(getMessage('paperSaveImageFallback', String(checks.images.originalFallbacks)));
	}
	if (checks?.attachments) lines.push(getMessage('paperAttachmentsSaved', String(checks.attachments.downloaded)));
	return { warning, message: lines.join('\n') };
}

function offerPermission() {
	authorize.querySelector('span')!.textContent = getMessage(directory ? 'paperDirectoryAuthorize' : input?.destination === 'once' ? 'saveChosenDirectory' : 'choosePaperDirectory');
	authorize.hidden = false;
}
async function showFailure(error: unknown) {
	const failure = paperDirectoryFailure(error);
	let summary: string | undefined;
	authorize.hidden = true;
	retry.hidden = true;
	keep.hidden = version.hidden = true;
	if (error instanceof ImageArchiveError) {
		summary = getMessage(`paperSaveImageError_${error.reason}`, String(error.imageNumber));
		// Image addresses can be signed; show them here without saving them in result history.
		const diagnostics = error.requests.map(({ imageNumber, url, httpStatus }) => {
			const http = httpStatus === undefined ? getMessage('paperSaveImageHttpUnavailable') : `HTTP ${httpStatus}`;
			return `${getMessage('paperSaveImageRequestDiagnostic', [String(imageNumber), http])} ${url}`;
		});
		status.textContent = [summary, ...diagnostics].join('\n');
		// Image preparation precedes all filesystem/download side effects.
		retry.hidden = !input || error.reason !== 'download';
	} else if (error instanceof AttachmentError) {
		status.textContent = getMessage(`paperAttachmentsError_${error.reason}`, String(error.attachmentNumber));
		retry.hidden = !input || error.reason !== 'download';
	} else {
		status.textContent = getMessage(failure.key, failure.detail);
		if (input && (input.format ?? 'directory') === 'directory' && ['paperDirectoryError_duplicate', 'paperDirectoryError_exists'].includes(failure.key)) {
			existingFolder = failure.detail;
			keep.hidden = version.hidden = false;
		}
		if (input && ['paperDirectoryError_permission', 'paperDirectoryError_missing'].includes(failure.key)) offerPermission();
	}
	status.dataset.error = 'true';
	await showAttention('failed', summary);
}
async function save() {
	authorize.hidden = true;
	retry.hidden = true;
	keep.hidden = version.hidden = true;
	status.dataset.error = 'false';
	status.dataset.warning = 'false';
	status.textContent = getMessage('paperDirectorySaving');
	void reportPaperDirectorySave(requestId, { state: 'saving', message: status.textContent });
	const progress = (done: number, total: number) => {
		status.textContent = done === total && input?.attachments?.length ? getMessage('paperAttachmentsProgress', String(input.attachments.length)) : getMessage('imageArchiveProgress', [String(done), String(total)]);
		void reportPaperDirectorySave(requestId, { state: 'saving', message: status.textContent });
	};
	document.getElementById('save-directory')!.textContent = directory!.name;
	const { source, format = 'directory', title } = input!;
	let checks: ManualExportChecks | undefined;
	if (format === 'directory') {
		const saved = await savePaperDirectory(directory!, input!, progress, { newVersion, imageDownloads: imageDownloads ??= createImageDownloadSession() });
		status.textContent = getMessage('paperDirectorySaved', directory!.name + '/' + saved.folder);
		checks = saved.checks;
	} else {
		let filename: string;
		let contents: string | Uint8Array;
		if (format === 'zip') {
			archive ??= await createImageArchive(input!.markdown, title, source, progress, input!.imageSources, input!.checkContext,
				input!.identity, input!.figureLinks, input!.attachments, input!.bibtex, imageDownloads ??= createImageDownloadSession());
			filename = archive.fileName;
			contents = archive.bytes;
			checks = archive.checks;
		} else {
			filename = (sanitizeFileName(title.replace(/\.md$/i, '')) || 'paper') + '.md';
			contents = input!.markdown;
		}
		const saved = await saveNewPaperFile(directory!, filename, contents);
		status.textContent = getMessage(format === 'zip' ? 'paperZipSaved' : 'paperDirectorySaved', directory!.name + '/' + saved);
	}
	const summary = checkSummary(checks);
	if (format !== 'markdown') status.textContent += '\n' + (summary.warning ? getMessage('paperSaveNeedsReview') + '\n' : '') + summary.message;
	status.dataset.warning = String(summary.warning);
	try {
		if (format === 'markdown') await incrementStat('markdown', undefined, undefined, source, title);
		else await addHistoryEntry(format, source, title);
	} catch { /* The paper is already saved. */ }
	input = undefined;
	archive = undefined;
	imageDownloads = undefined;
	await reportPaperDirectorySave(requestId, { state: summary.warning ? 'saved-warning' : 'saved', message: status.textContent }, source);
	if (summary.warning) await revealSavePage();
	else window.close();
}
async function runSave(withPermission: boolean) {
	if (busy || !input) return;
	busy = true; authorize.disabled = retry.disabled = close.disabled = keep.disabled = version.disabled = true;
	try {
		// This click is in a top-level extension document with a real user gesture.
		if (withPermission) {
			directory = directory ? await authorizePaperDirectory(directory) : await choosePaperDirectory(input.destination);
		}
		await save();
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') {
			status.textContent = getMessage('paperDirectoryCancelled');
			offerPermission();
			await showAttention('failed');
		} else await showFailure(error);
	} finally { busy = false; authorize.disabled = retry.disabled = close.disabled = keep.disabled = version.disabled = false; }
}
authorize.addEventListener('click', () => { void runSave(true); });
retry.addEventListener('click', () => { void runSave(false); });
close.addEventListener('click', () => window.close());
version.addEventListener('click', () => {
	if (busy || version.hidden || !input) return;
	newVersion = true;
	void runSave(false);
});
keep.addEventListener('click', async () => {
	if (busy || keep.hidden || !input) return;
	busy = true;
	keep.disabled = version.disabled = true;
	const source = input.source;
	input = undefined;
	imageDownloads = undefined;
	status.textContent = getMessage('paperDirectoryKept', existingFolder);
	await reportPaperDirectorySave(requestId, { state: 'skipped', message: status.textContent }, source);
	window.close();
});

async function initialize() {
	await translatePage();
	await setupLanguageAndDirection();
	createIcons({ icons: { FolderOpen, RotateCw, CopyPlus, Check, X } });
	close.title = close.ariaLabel = getMessage('close');
	if (window.top !== window) throw new Error('Save page must be top-level.');
	input = await takePaperDirectorySave(requestId);
	document.getElementById('paper-title')!.textContent = input.title;
	document.getElementById('save-heading')!.textContent = getMessage(input.format === 'zip' ? 'saveImageArchive' : input.format === 'markdown' ? 'saveMarkdownWithImageLinks' : 'savePaperDirectory');
	if (input.destination !== 'once') directory = await getPaperDirectory();
	if (!directory || await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') {
		status.textContent = getMessage(directory ? 'paperDirectoryNeedsPermission' : input.destination === 'once' ? 'paperChooseOncePrompt' : 'paperDirectoryError_missing');
		document.getElementById('save-directory')!.textContent = directory?.name ?? '';
		offerPermission();
		await showAttention();
		return;
	}
	await runSave(false);
}
initialize().catch(showFailure);
