import { withoutInterpreterSettings } from '../managers/interpreter-settings';
import { Template } from '../types/types';
import { templates, saveTemplateSettings, editingTemplateIndex, loadTemplates, decodeTemplate, encodeTemplate, checkStoredTemplate } from '../managers/template-manager';
import { showTemplateEditor, updateTemplateList } from '../managers/template-ui';
import { sanitizeFileName } from './string-utils';
import { generalSettings, loadSettings } from '../utils/storage-utils';
import { addPropertyType, updatePropertyTypesList } from '../managers/property-types-manager';
import { showImportModal } from './import-modal';
import browser from '../utils/browser-polyfill';
import { saveFile } from './file-utils';
import { copyToClipboard } from './clipboard-utils';
import { getMessage } from './i18n';

const SCHEMA_VERSION = '0.1.0';

interface StorageData {
	[key: string]: any;
	template_list?: string[];
}

export async function exportTemplate(): Promise<void> {
	if (editingTemplateIndex === -1) {
		alert(getMessage('selectTemplateToExport'));
		return;
	}

	const template = templates[editingTemplateIndex] as Template;
	const sanitizedName = sanitizeFileName(template.name);
	const fileName = `${sanitizedName.replace(/\s+/g, '-').toLowerCase()}-clipper.json`;

	const content = serializeTemplate(template);

	try {
		await saveFile({ content, fileName, mimeType: 'application/json' });
	} catch (error) {
		console.error('Failed to export template:', error);
		alert(getMessage('failedToSaveFile'));
	}
}

function serializeTemplate(template: Template): string {
	const isDailyNote = template.behavior === 'append-daily' || template.behavior === 'prepend-daily';

	const orderedTemplate: Partial<Template> & { schemaVersion: string } = {
		schemaVersion: SCHEMA_VERSION,
		name: template.name,
		behavior: template.behavior,
		noteContentFormat: template.noteContentFormat,
		properties: template.properties.map(({ name, value, type }) => ({
			name,
			value,
			type: type || generalSettings.propertyTypes.find(pt => pt.name === name)?.type || 'text'
		})),
		triggers: template.triggers,
	};

	// Only include noteNameFormat and path for non-daily note behaviors
	if (!isDailyNote) {
		orderedTemplate.noteNameFormat = template.noteNameFormat;
		orderedTemplate.path = template.path;
	}

	// Include context only if it has a value
	if (template.context) {
		orderedTemplate.context = template.context;
	}

	return JSON.stringify(orderedTemplate, null, 2);
}

async function processImportedTemplate(input: Partial<Template>): Promise<Template> {
	const isDailyNote = input?.behavior === 'append-daily' || input?.behavior === 'prepend-daily';
	if (!input || typeof input.behavior !== 'string' ||
		(!isDailyNote && (typeof input.noteNameFormat !== 'string' || typeof input.path !== 'string')) ||
		(input.context != null && typeof input.context !== 'string')) {
		throw new Error('Invalid template file');
	}
	const id = crypto.randomUUID();
	const importedTemplate = { ...input, id, noteNameFormat: input.noteNameFormat ?? '{{title}}', path: input.path ?? '' };
	checkStoredTemplate(id, importedTemplate);
	const validTypes = ['text', 'multitext', 'number', 'checkbox', 'date', 'datetime'];
	if (importedTemplate.properties.some(prop => prop.type !== undefined && !validTypes.includes(prop.type))) {
		throw new Error('Invalid template property type');
	}
	for (const prop of importedTemplate.properties) {
		const existing = generalSettings.propertyTypes.find(pt => pt.name === prop.name);
		if (!existing) await addPropertyType(prop.name, prop.type || 'text', prop.value);
		prop.type = existing?.type ?? (prop.type || 'text');
		prop.id ||= crypto.randomUUID();
	}

	// Ensure unique name
	let newName = importedTemplate.name;
	let counter = 1;
	while (templates.some(t => t.name === newName)) {
		newName = `${importedTemplate.name} (${counter++})`;
	}
	importedTemplate.name = newName;

	return importedTemplate;
}

export function showTemplateImportModal(): void {
	showImportModal(
		'import-modal',
		importTemplateFromJson,
		'.json',
		'importTemplate'
	);
}

async function importTemplateFromJson(jsonContent: string): Promise<void> {
	const template = await processImportedTemplate(JSON.parse(jsonContent));
	templates.unshift(template);
	try {
		await saveTemplateSettings();
	} catch (error) {
		const index = templates.indexOf(template);
		if (index >= 0) templates.splice(index, 1);
		throw error;
	}
	updateTemplateList();
	showTemplateEditor(template);
}

export function copyTemplateToClipboard(template: Template): void {
	copyToClipboard(serializeTemplate(template)).then(success => {
		if (success) {
			alert(getMessage('templateCopied'));
		} else {
			alert(getMessage('templateCopyError'));
		}
	});
}

export async function exportAllSettings(): Promise<void> {
	try {
		const allData = await browser.storage.sync.get(null) as StorageData;

		// Create a copy of the data to modify
		const exportData: StorageData = Object.fromEntries(
			Object.entries(withoutInterpreterSettings(allData)).filter(([, value]) => value !== null)
		);

		// Fresh or older installations may not have saved vault preferences yet.
		exportData.vaults ??= [];
		if (exportData.template_list === undefined && Object.keys(exportData).some(key => key.startsWith('template_'))) {
			throw new Error('Cannot export templates with a missing index');
		}
		exportData.template_list ??= [];
		// Decompress all templates
		const templateIds = exportData.template_list;
		const activeKeys = new Set(templateIds.map(id => 'template_' + id));
		for (const key of Object.keys(exportData)) {
			if (key.startsWith('template_') && key !== 'template_list' && !activeKeys.has(key)) delete exportData[key];
		}
		for (const id of templateIds) {
			const key = `template_${id}`;
			exportData[key] = decodeTemplate(id, exportData[key]);
		}

		const content = JSON.stringify(exportData, null, 2);

		const fileName = 'paper-clipper-settings.json';

		await saveFile({
			content,
			fileName,
			mimeType: 'application/json'
		});

	} catch (error) {
		console.error('Error in exportAllSettings:', error);
		alert(getMessage('failedToExportSettings'));
	}
}

export function importAllSettings(): void {
	showImportModal(
		'import-modal',
		importAllSettingsFromJson,
		'.json',
		'importAllSettings'
	);
}

async function restoreSettingsBackup(importData: StorageData): Promise<void> {
	const current = await browser.storage.sync.get(null);
	// An older export can contain templates but omit never-saved vault preferences.
	if (importData.vaults === undefined && current.vaults !== undefined) importData.vaults = current.vaults;
	const obsolete = Object.keys(current).filter(key => !Object.prototype.hasOwnProperty.call(importData, key));
	// Retire old values and install the new template index and payloads in one quota-checked write.
	// If Chrome rejects it, the previous settings and every referenced template are still intact.
	const retiredValues = Object.fromEntries(obsolete.map(key => [key, null]));
	await browser.storage.sync.set({ ...retiredValues, ...importData });
	if (obsolete.length) {
		try {
			await browser.storage.sync.remove(obsolete);
		} catch (error) {
			// Null entries are already inactive. A later restore can reclaim their keys.
			console.warn('Settings restored, but empty sync entries could not be removed:', error);
		}
	}
}

export async function importAllSettingsFromJson(jsonContent: string): Promise<void> {
	try {
		const settings = JSON.parse(jsonContent) as StorageData;
		if (!settings || !Array.isArray(settings.template_list) ||
			!settings.template_list.every(id => typeof id === 'string' && id.length > 0 && id !== 'list') ||
			new Set(settings.template_list).size !== settings.template_list.length) {
			throw new Error('Missing or invalid template index');
		}
		if (settings.vaults === undefined ? !settings.template_list.length :
			!Array.isArray(settings.vaults) || !settings.vaults.every((vault: unknown) => typeof vault === 'string')) {
			throw new Error('Missing or invalid vault list');
		}
		for (const key of ['general_settings', 'reader_settings', 'highlighter_settings', 'stats']) {
			if (key in settings && (!settings[key] || typeof settings[key] !== 'object' || Array.isArray(settings[key]))) {
				throw new Error('Invalid settings section: ' + key);
			}
		}
		if ('property_types' in settings && (!Array.isArray(settings.property_types) ||
			!settings.property_types.every((p: { name?: string; type?: string }) => p && typeof p.name === 'string' && typeof p.type === 'string'))) {
			throw new Error('Invalid property types');
		}
		const importData: StorageData = withoutInterpreterSettings(settings);
		const ids = new Set(settings.template_list);
		if (Object.keys(importData).some(key => key.startsWith('template_') && key !== 'template_list' && !ids.has(key.slice(9)))) {
			throw new Error('Backup contains templates missing from its index');
		}
		for (const id of ids) {
			const key = 'template_' + id;
			if (Array.isArray(importData[key])) {
				decodeTemplate(id, importData[key]);
			} else {
				checkStoredTemplate(id, importData[key]);
				importData[key] = encodeTemplate(importData[key]);
			}
		}
		if (confirm(getMessage('confirmReplaceSettings'))) {
			await navigator.locks.request('paper-clipper-settings-import', async () => {
				await restoreSettingsBackup(importData);
				await loadSettings();
				await loadTemplates();
				updateTemplateList();
				updatePropertyTypesList();
			});
			alert(getMessage('settingsImportSuccess'));
		}
	} catch (error) {
		console.error('Error importing all settings:', error);
		throw new Error('Error importing settings. Please check the file and try again.');
	}
}
