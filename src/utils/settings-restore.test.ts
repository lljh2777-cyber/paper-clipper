// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { compressToUTF16 } from 'lz-string';
import { importAllSettingsFromJson } from './import-export';
import { loadTemplates } from '../managers/template-manager';
import { loadSettings } from './storage-utils';

const sync = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), remove: vi.fn() }));
vi.mock('./browser-polyfill', () => ({ default: { storage: { sync } } }));
vi.mock('./i18n', () => ({ getMessage: (key: string) => key }));
vi.mock('../managers/template-ui', () => ({ updateTemplateList: vi.fn() }));
vi.mock('../managers/property-types-manager', () => ({ addPropertyType: vi.fn(), updatePropertyTypesList: vi.fn() }));

const template = (id: string) => ({ id, name: id, properties: [], noteNameFormat: '{{title}}', noteContentFormat: '{{content}}' });
const pack = (id: string) => [compressToUTF16(JSON.stringify(template(id)))];
const backup = { migrationVersion: 1, template_list: ['new'], template_new: template('new'), vaults: ['New'] };
let stored: Record<string, unknown>;

beforeEach(() => {
	stored = { migrationVersion: 1, template_list: ['old'], template_old: pack('old'), vaults: ['Old'] };
	sync.get.mockImplementation(async (keys: string | string[] | null) => keys === null ? { ...stored } :
		Object.fromEntries([keys].flat().map(key => [key, stored[key]])));
	sync.set.mockImplementation(async values => { Object.assign(stored, values); });
	sync.remove.mockImplementation(async (keys: string[]) => { for (const key of keys) delete stored[key]; });
	vi.stubGlobal('confirm', () => true);
	vi.stubGlobal('alert', vi.fn());
	Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, run: () => Promise<void>) => run() } });
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(navigator, 'locks');
});

it('retains a readable previous template and vault when Chrome rejects the backup write', async () => {
	const original = { ...stored };
	sync.set.mockRejectedValueOnce(new Error('QUOTA_BYTES'));
	await expect(importAllSettingsFromJson(JSON.stringify(backup))).rejects.toThrow();
	expect(stored).toEqual(original);
	expect(sync.remove).not.toHaveBeenCalled();
	expect(await loadTemplates()).toEqual([template('old')]);
	expect((await loadSettings()).vaults).toEqual(['Old']);
});

it('rejects a backup with a missing template before touching sync storage', async () => {
	await expect(importAllSettingsFromJson(JSON.stringify({ ...backup, template_new: null }))).rejects.toThrow();
	expect(sync.set).not.toHaveBeenCalled();
	expect(await loadTemplates()).toEqual([template('old')]);
});

it('can retry cleanup after a successful restore and read legacy compressed backups', async () => {
	sync.remove.mockRejectedValueOnce(new Error('write limit'));
	await importAllSettingsFromJson(JSON.stringify(backup));
	expect(stored.template_old).toBeNull();
	expect(await loadTemplates()).toEqual([template('new')]);
	await importAllSettingsFromJson(JSON.stringify({ ...backup, template_new: pack('new') }));
	expect(stored).toEqual({ ...backup, template_new: pack('new') });
});
