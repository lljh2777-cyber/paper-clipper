import { Template, Property, PropertyType } from '../types/types';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';
import browser from '../utils/browser-polyfill';
import { generalSettings } from '../utils/storage-utils';
import { addPropertyType } from './property-types-manager';
import { getMessage } from '../utils/i18n';

export let templates: Template[] = [];
export let editingTemplateIndex = -1;

const STORAGE_KEY_PREFIX = 'template_';
const TEMPLATE_LIST_KEY = 'template_list';
const CHUNK_SIZE = 8000;
const SIZE_WARNING_THRESHOLD = 6000;

export function setEditingTemplateIndex(index: number): void {
	editingTemplateIndex = index;
}

export async function loadTemplates(): Promise<Template[]> {
	// The index and its payloads must come from the same sync snapshot.
	let data = await browser.storage.sync.get(null);
	if (data.template_list === undefined) {
		data = await navigator.locks.request('paper-clipper-settings-import', async () => {
			const latest = await browser.storage.sync.get(null);
			if (latest.template_list !== undefined) return latest;
			if (Object.keys(latest).some(key => key.startsWith(STORAGE_KEY_PREFIX) && latest[key] != null)) {
				throw new Error('Template index is missing. Recover the index before editing templates.');
			}
			const first = createDefaultTemplate();
			const initial = { template_list: [first.id], [STORAGE_KEY_PREFIX + first.id]: encodeTemplate(first) };
			await browser.storage.sync.set(initial);
			return initial;
		});
	}
	if (!Array.isArray(data.template_list)) throw new Error('Invalid template index');
	// Publish no partial list: a later autosave must never discard an unreadable entry.
	templates = data.template_list.filter(id => id != null).map(id => {
		if (typeof id !== 'string') throw new Error('Invalid template ID');
		return decodeTemplate(id, data[STORAGE_KEY_PREFIX + id]);
	});
	await updateGlobalPropertyTypes(templates);
	return templates;
}

export function decodeTemplate(id: string, chunks: unknown): Template {
	if (!Array.isArray(chunks) || !chunks.every(chunk => typeof chunk === 'string')) {
		throw new Error('Missing template data: ' + id);
	}
	const template = JSON.parse(decompressFromUTF16(chunks.join('')));
	checkStoredTemplate(id, template);
	return template;
}

export function checkStoredTemplate(id: string, value: unknown): asserts value is Template {
	const template = value as Partial<Template> | null;
	if (!template || template.id !== id || typeof template.name !== 'string' ||
		typeof template.noteNameFormat !== 'string' || typeof template.noteContentFormat !== 'string' ||
		!Array.isArray(template.properties) || !template.properties.every((p: Property) =>
			p && typeof p.name === 'string' && typeof p.value === 'string')) {
		throw new Error('Invalid template data: ' + id);
	}
}

export function encodeTemplate(template: Template): string[] {
	const data = compressToUTF16(JSON.stringify(template));
	const chunks: string[] = [];
	for (let start = 0; start < data.length; start += CHUNK_SIZE) chunks.push(data.slice(start, start + CHUNK_SIZE));
	return chunks;
}

export async function saveTemplateSettings(): Promise<string[]> {
	const templateIds = templates.map(t => t.id);
	const warnings: string[] = [];
	const templateChunks: { [key: string]: string[] } = {};

	for (const template of templates) {
		if (!template.noteNameFormat || template.noteNameFormat.trim() === '') {
			warnings.push(`Warning: Template "${template.name}" has an empty note name format. Using default "{{title}}".`);
			template.noteNameFormat = '{{title}}';
		}

		const chunks = encodeTemplate(template);
		templateChunks[STORAGE_KEY_PREFIX + template.id] = chunks;
		const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
		if (length > SIZE_WARNING_THRESHOLD) {
			warnings.push(`Warning: Template "${template.name}" is approaching the storage limit.`);
		}
	}

	try {
		await browser.storage.sync.set({ ...templateChunks, [TEMPLATE_LIST_KEY]: templateIds });
		console.log('Template settings saved');
		return warnings;
	} catch (error) {
		console.error('Error saving templates:', error);
		throw error;
	}
}

export function createDefaultTemplate(): Template {
	return {
		id: Date.now().toString() + Math.random().toString(36).slice(2, 11),
		name: getMessage('defaultTemplateName'),
		behavior: 'create',
		noteNameFormat: '{{title}}',
		path: 'Clippings',
		noteContentFormat: '{{content}}',
		context: "",
		properties: [
			{ id: Date.now().toString() + Math.random().toString(36).slice(2, 11), name: 'title', value: '{{title}}' },
			{ id: Date.now().toString() + Math.random().toString(36).slice(2, 11), name: 'source', value: '{{url}}' },
			{ id: Date.now().toString() + Math.random().toString(36).slice(2, 11), name: 'author', value: '{{author|split:", "|wikilink|join}}' },
			{ id: Date.now().toString() + Math.random().toString(36).slice(2, 11), name: 'published', value: '{{published}}' },
			{ id: Date.now().toString() + Math.random().toString(36).slice(2, 11), name: 'created', value: '{{date}}' },
			{ id: Date.now().toString() + Math.random().toString(36).slice(2, 11), name: 'description', value: '{{description}}' },
			{ id: Date.now().toString() + Math.random().toString(36).slice(2, 11), name: 'tags', value: 'clippings' }
		],
		triggers: []
	};
}

export function getEditingTemplateIndex(): number {
	return editingTemplateIndex;
}

export function getTemplates(): Template[] {
	return templates;
}

export function findTemplateById(id: string): Template | undefined {
	return templates.find(template => template.id === id);
}

export function duplicateTemplate(templateId: string): Template {
	const originalTemplate = templates.find(t => t.id === templateId);
	if (!originalTemplate) {
		throw new Error('Template not found');
	}

	const newTemplate: Template = JSON.parse(JSON.stringify(originalTemplate));
	newTemplate.id = Date.now().toString() + Math.random().toString(36).slice(2, 11);
	newTemplate.name = getUniqueTemplateName(originalTemplate.name);
	
	templates.unshift(newTemplate);
	return newTemplate;
}

function getUniqueTemplateName(baseName: string): string {
	const baseNameWithoutNumber = baseName.replace(/\s\d+$/, '');
	const existingNames = new Set(templates.map(t => t.name));
	let newName = baseNameWithoutNumber;
	let counter = 1;

	while (existingNames.has(newName)) {
		counter++;
		newName = `${baseNameWithoutNumber} ${counter}`;
	}

	return newName;
}

export async function deleteTemplate(templateId: string): Promise<boolean> {
	const index = templates.findIndex(t => t.id === templateId);
	console.log('Deleting template:', templateId);
	if (index !== -1) {
		// Remove from the templates array
		templates.splice(index, 1);
		setEditingTemplateIndex(-1);

		try {
			// Remove the template from storage
			await browser.storage.sync.remove(`template_${templateId}`);

			// Get the current template_list
			const data = await browser.storage.sync.get('template_list');
			let templateIds = data.template_list as string[] || [];

			// Remove the deleted template ID from the list
			templateIds = templateIds.filter(id => id !== templateId);

			// Update the template_list in storage
			await browser.storage.sync.set({ 'template_list': templateIds });

			console.log(`Template ${templateId} deleted successfully`);
			return true;
		} catch (error) {
			console.log('Error deleting template:', error);
			return false;
		}
	}
	console.log('Error deleting template');
	return false;
}

async function updateGlobalPropertyTypes(templates: Template[]): Promise<void> {
	const existingTypes = new Set(generalSettings.propertyTypes.map(p => p.name));
	const newTypes: PropertyType[] = [];

	const defaultTypes: { [key: string]: { type: string, defaultValue: string } } = {
		'title': { type: 'text', defaultValue: '{{title}}' },
		'source': { type: 'text', defaultValue: '{{url}}' },
		'author': { type: 'multitext', defaultValue: '{{author|split:", "|wikilink|join}}' },
		'published': { type: 'date', defaultValue: '{{published}}' },
		'created': { type: 'date', defaultValue: '{{date}}' },
		'description': { type: 'text', defaultValue: '{{description}}' },
		'tags': { type: 'multitext', defaultValue: 'clippings' }
	};

	templates.forEach(template => {
		template.properties.forEach(property => {
			if (!existingTypes.has(property.name)) {
				const defaultType = defaultTypes[property.name] || { type: 'text', defaultValue: '' };
				newTypes.push({ 
					name: property.name, 
					type: defaultType.type,
					defaultValue: defaultType.defaultValue
				});
				existingTypes.add(property.name);
			}
		});
	});

	for (const newType of newTypes) {
		await addPropertyType(newType.name, newType.type, newType.defaultValue);
	}
}

export async function rebuildTemplateList(): Promise<void> {
	try {
		// Get all items in storage
		const allItems = await browser.storage.sync.get(null);
		
		// Filter for template keys and extract IDs
		const templateIds = Object.keys(allItems)
			.filter(key => key.startsWith('template_') && key !== 'template_list' && Array.isArray(allItems[key]))
			.map(key => key.replace('template_', ''));

		console.log('Found template IDs:', templateIds);

		// Update the template_list in storage
		await browser.storage.sync.set({ 'template_list': templateIds });

		console.log('Template list rebuilt successfully');

		// Reload templates
		templates = await loadTemplates();

		console.log('Templates reloaded:', templates);
	} catch (error) {
		console.error('Error rebuilding template list:', error);
	}
}

export async function cleanupTemplateStorage(): Promise<void> {
	await rebuildTemplateList();
	await loadTemplates();
	console.log('Template storage cleaned up and rebuilt');
}
