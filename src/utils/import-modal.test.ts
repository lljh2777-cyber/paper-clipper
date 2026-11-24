// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { showImportModal } from './import-modal';

vi.mock('./i18n', () => ({ getMessage: (key: string) => key, translatePage: async () => {} }));

beforeEach(() => {
	const settings = new DOMParser().parseFromString(readFileSync('src/settings.html', 'utf8'), 'text/html');
	document.body.replaceChildren(settings.querySelector('#import-modal')!);
});

it.each(['Escape', 'backdrop', 'cancel'])('tears down the old importer when closed by %s', async method => {
	const previous = vi.fn(), current = vi.fn();
	await showImportModal('import-modal', previous);
	if (method === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
	else document.querySelector<HTMLElement>(method === 'cancel' ? '.import-cancel-btn' : '.modal-bg')!.click();
	await showImportModal('import-modal', current);
	document.querySelector('textarea')!.value = '{}';
	document.querySelector<HTMLButtonElement>('.import-confirm-btn')!.click();
	await vi.waitFor(() => expect(document.getElementById('import-modal')!.style.display).toBe('none'));
	expect(previous).not.toHaveBeenCalled();
	expect(current).toHaveBeenCalledExactlyOnceWith('{}');
});
