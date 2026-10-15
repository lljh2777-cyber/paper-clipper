import { createIcons, FolderOpen, X } from 'lucide';
import { getMessage, setupLanguageAndDirection, translatePage } from '../utils/i18n';
import { authorizePaperDirectory, choosePaperDirectory, getPaperDirectory, PaperDirectoryInput, paperDirectoryFailure, savePaperDirectory, WritableDirectory } from '../utils/paper-directory';
import { takePaperDirectorySave } from '../utils/paper-directory-handoff';
import { manualChecksMessageKey } from '../utils/manual-export-report';

const status = document.getElementById('save-status')!;
const authorize = document.getElementById('authorize-save') as HTMLButtonElement;
const close = document.getElementById('close-save') as HTMLButtonElement;
let directory: WritableDirectory | undefined;
let input: PaperDirectoryInput | undefined;
let busy = false;

function offerPermission() {
	authorize.querySelector('span')!.textContent = getMessage(directory ? 'paperDirectoryAuthorize' : 'choosePaperDirectory');
	authorize.hidden = false;
}
function showFailure(error: unknown) {
	const failure = paperDirectoryFailure(error);
	status.textContent = getMessage(failure.key, failure.detail);
	status.dataset.error = 'true';
	if (input && ['paperDirectoryError_permission', 'paperDirectoryError_missing'].includes(failure.key)) offerPermission();
}
async function save() {
	authorize.hidden = true;
	status.dataset.error = 'false';
	status.textContent = getMessage('paperDirectorySaving');
	document.getElementById('save-directory')!.textContent = directory!.name;
	const folder = await savePaperDirectory(directory!, input!, (done, total) => {
		status.textContent = getMessage('imageArchiveProgress', [String(done), String(total)]);
	});
	status.textContent = getMessage('paperDirectorySaved', `${directory!.name}/${folder}`) + ' ' + getMessage(manualChecksMessageKey(input?.checkContext?.report));
	input = undefined;
}
authorize.addEventListener('click', async () => {
	if (busy || !input) return;
	busy = true; authorize.disabled = true; close.disabled = true;
	try {
		// This click is in a top-level extension document with a real user gesture.
		directory = directory ? await authorizePaperDirectory(directory) : await choosePaperDirectory();
		await save();
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') {
			status.textContent = getMessage('paperDirectoryCancelled');
			offerPermission();
		} else showFailure(error);
	} finally { busy = false; authorize.disabled = false; close.disabled = false; }
});
close.addEventListener('click', () => window.close());

async function initialize() {
	await translatePage();
	await setupLanguageAndDirection();
	createIcons({ icons: { FolderOpen, X } });
	close.title = close.ariaLabel = getMessage('close');
	if (window.top !== window) throw new Error('Save page must be top-level.');
	input = await takePaperDirectorySave(location.hash.slice(1));
	document.getElementById('paper-title')!.textContent = input.title;
	directory = await getPaperDirectory();
	if (!directory || await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') {
		status.textContent = getMessage(directory ? 'paperDirectoryNeedsPermission' : 'paperDirectoryError_missing');
		document.getElementById('save-directory')!.textContent = directory?.name ?? '';
		offerPermission();
		return;
	}
	busy = true; close.disabled = true;
	try { await save(); }
	finally { busy = false; close.disabled = false; }
}
initialize().catch(showFailure);
