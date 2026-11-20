// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { compileTemplate } from './template-compiler';
import { withoutInterpreterSettings } from '../managers/interpreter-settings';
import { loadSettings } from './storage-utils';
import browser from './browser-polyfill';

vi.mock('./browser-polyfill', () => ({ default: { storage: { sync: { get: vi.fn(), remove: vi.fn() } } } }));

test('loading settings after an upgrade removes only the old interpreter settings', async () => {
	vi.mocked(browser.storage.sync.get).mockResolvedValue({
		migrationVersion: 1, vaults: ['Papers'], interpreter_settings: { providers: [{ apiKey: 'example' }] },
	});
	expect((await loadSettings()).vaults).toEqual(['Papers']);
	expect(browser.storage.sync.remove).toHaveBeenCalledExactlyOnceWith('interpreter_settings');
});

test('legacy AI slots stay empty and ordinary fields still render', async () => {
	const result = await compileTemplate(0, '{{title}}/{{ "Summarize {{title}}" | upper }}/{{modelId}}/{{content}}',
		{ title: 'Paper', content: 'Body' }, 'https://example.org');
	expect(result).toBe('Paper///Body');
});

test('backup and restore discard retired provider settings and preserve ordinary preferences', () => {
	expect(withoutInterpreterSettings({ vaults: ['Papers'], interpreter_settings: { providers: [{ apiKey: 'example' }] } }))
		.toEqual({ vaults: ['Papers'] });
});
