import { showModal, hideModal } from './modal-utils';
import { getMessage, translatePage } from './i18n';

export async function showImportModal(
	modalId: string,
	importFunction: (content: string) => Promise<void>,
	fileExtension: string = '.json',
	modalTitleKey: string = 'import'
): Promise<void> {
	const modal = document.getElementById(modalId);
	const dropZone = modal?.querySelector('.import-drop-zone') as HTMLElement;
	const jsonTextarea = modal?.querySelector('.import-json-textarea') as HTMLTextAreaElement;
	const cancelBtn = modal?.querySelector('.import-cancel-btn') as HTMLElement;
	const confirmBtn = modal?.querySelector('.import-confirm-btn') as HTMLElement;
	const titleElement = modal?.querySelector('.modal-title') as HTMLElement;

	if (!modal || !dropZone || !jsonTextarea || !cancelBtn || !confirmBtn || !titleElement) {
		console.error('Import modal elements not found');
		return;
	}

	// Set data-i18n attributes
	titleElement.setAttribute('data-i18n', modalTitleKey);
	const dropZoneTextElement = dropZone.querySelector('p');
	if (dropZoneTextElement) {
		dropZoneTextElement.setAttribute('data-i18n', 'dragAndDropFile');
	}
	jsonTextarea.setAttribute('data-i18n', 'pasteJsonHere');
	cancelBtn.setAttribute('data-i18n', 'cancel');
	confirmBtn.setAttribute('data-i18n', 'import');

	const orText = modal.querySelector('.import-or-text');
	if (orText) {
		orText.setAttribute('data-i18n', 'orPasteBelow');
	}

	// Clear the textarea when showing the modal
	jsonTextarea.value = '';

	const signal = showModal(modal);
	const options = { signal };
	let busy = false;

	const submit = async (inputs: (File | string)[]) => {
		if (busy || signal.aborted) return;
		busy = true;
		try {
			for (const input of inputs) {
				const content = typeof input === 'string' ? input : await input.text();
				if (signal.aborted) return;
				await importFunction(content);
			}
			if (!signal.aborted) hideModal(modal);
		} catch (error) {
			console.error('Import failed:', error);
			if (!signal.aborted) alert(getMessage('importFailed'));
		} finally {
			busy = false;
		}
	};

	function importFiles(files: FileList | null) {
		if (files?.length) void submit(Array.from(files));
	}

	const picker = document.createElement('input');
	picker.type = 'file';
	picker.accept = fileExtension;
	picker.multiple = true;
	picker.addEventListener('change', () => {
		importFiles(picker.files);
		picker.value = '';
	}, options);
	dropZone.addEventListener('click', () => { if (!busy) picker.click(); }, options);
	dropZone.addEventListener('dragover', event => event.preventDefault(), options);
	dropZone.addEventListener('drop', event => {
		event.preventDefault();
		importFiles(event.dataTransfer?.files ?? null);
	}, options);
	cancelBtn.addEventListener('click', () => hideModal(modal), options);
	confirmBtn.addEventListener('click', () => {
		const content = jsonTextarea.value.trim();
		if (content) void submit([content]);
	}, options);
	await translatePage();
}
