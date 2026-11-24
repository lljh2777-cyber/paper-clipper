const sessions = new WeakMap<HTMLElement, AbortController>();

export function showModal(modal: HTMLElement): AbortSignal {
	sessions.get(modal)?.abort();
	const controller = new AbortController();
	sessions.set(modal, controller);
	modal.style.display = 'flex';
	const options = { signal: controller.signal };
	modal.querySelector('.modal-bg')?.addEventListener('click', () => hideModal(modal), options);
	document.addEventListener('keydown', event => {
		if (event.key === 'Escape') hideModal(modal);
	}, options);
	return controller.signal;
}

export function hideModal(modal: HTMLElement): void {
	sessions.get(modal)?.abort();
	sessions.delete(modal);
	modal.style.display = 'none';
	const textarea = modal.querySelector<HTMLTextAreaElement>('.import-json-textarea');
	if (textarea) textarea.value = '';
}
