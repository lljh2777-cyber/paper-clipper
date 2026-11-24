// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { openPaperDirectorySave } from '../utils/paper-directory-handoff';
import { compileTemplate } from '../utils/template-compiler';
import { incrementStat } from '../utils/storage-utils';
import { generateFrontmatter } from '../utils/obsidian-note-creator';

const state = vi.hoisted(() => ({
	active: 1,
	activate: (_event: { windowId: number; tabId: number }) => {},
	extract: vi.fn(),
}));

const url = (id: number) => 'https://example.org/paper/' + id;
vi.mock('../utils/browser-polyfill', () => ({ default: {
	runtime: { connect: vi.fn(), onMessage: { addListener: vi.fn() },
		sendMessage: async ({ action, tabId }: { action: string; tabId: number }) => action === 'getTabInfo'
			? { success: true, tab: { id: tabId, windowId: 7, active: tabId === state.active, url: url(tabId) } }
			: {} },
	tabs: { query: async () => [{ id: state.active }], onUpdated: { addListener: vi.fn() },
		onActivated: { addListener: (listener: typeof state.activate) => { state.activate = listener; } } },
	storage: { sync: { set: vi.fn(), onChanged: { addListener: vi.fn() } }, local: { onChanged: { addListener: vi.fn() } } },
} }));
vi.mock('../utils/storage-utils', () => ({
	loadSettings: async () => ({ vaults: [], saveBehavior: 'savePaperDirectory' }),
	incrementStat: vi.fn().mockResolvedValue(undefined), getClipHistory: async () => [
		{ url: url(3), action: 'directory' }, { url: url(3), action: 'directory' },
		{ url: url(3), action: 'zip' }, { url: url(1), action: 'copyToClipboard' },
	], getLocalStorage: async () => undefined, generalSettings: { propertyTypes: [] },
}));
vi.mock('../utils/browser-detection', () => ({ addBrowserClassToHtml: vi.fn(), detectBrowser: async () => 'chrome' }));
vi.mock('../utils/i18n', () => ({ getMessage: (key: string, detail?: string) => detail ?? key, translatePage: vi.fn(), setupLanguageAndDirection: vi.fn() }));
vi.mock('../icons/icons', () => ({ initializeIcons: vi.fn(), getPropertyTypeIcon: () => 'text' }));
vi.mock('../managers/template-manager', () => ({ loadTemplates: async () => [{
	id: 'test', name: 'Article', properties: [{ name: 'doi', value: 'doi' }],
	noteNameFormat: 'title', noteContentFormat: 'content', path: '', context: '{{selector:.legacy-ai-context}}',
}] }));
vi.mock('../utils/content-extractor', () => ({
	extractPageContent: state.extract,
	initializePageContent: async (content: string, _selection: string, variables: Record<string, string>) =>
		({ currentVariables: { content, ...variables } }),
}));
vi.mock('../utils/template-compiler', () => ({ compileTemplate: vi.fn() }));
vi.mock('../utils/obsidian-note-creator', () => ({ generateFrontmatter: vi.fn(async () => '') }));
vi.mock('../utils/paper-directory-handoff', () => ({ lastPaperSaveResult: vi.fn(), openPaperDirectorySave: vi.fn() }));
vi.mock('../managers/inspect-variables', () => ({ updateVariablesPanel: vi.fn() }));

function paper(id: number) {
	const doi = '10.1234/paper' + id;
	return { sourceUrl: url(id), content: 'Body ' + id, title: 'Title ' + id,
		extractedContent: { title: 'Title ' + id, doi }, fullHtml: '<article>Body ' + id + '</article>',
		metaTags: [{ name: 'citation_doi', content: doi }], published: '2026' };
}

it('hands off only the current article after out-of-order extraction and compilation', async () => {
	history.replaceState(null, '', '/side-panel.html');
	document.body.innerHTML = new DOMParser().parseFromString(readFileSync('src/side-panel.html', 'utf8'), 'text/html').body.innerHTML;
	document.documentElement.classList.add('is-side-panel');
	let releaseExtraction!: (data: ReturnType<typeof paper>) => void;
	state.extract.mockImplementation(async (id: number) => id === 1
		? new Promise(resolve => { releaseExtraction = resolve; }) : paper(id));
	let releaseTemplate!: (value: string) => void;
	vi.mocked(compileTemplate).mockImplementation(async (id, field, variables) => id === 2 && field === 'content'
		? new Promise(resolve => { releaseTemplate = resolve; }) : variables[field] ?? '');
	vi.mocked(openPaperDirectorySave).mockResolvedValue({ finished: Promise.resolve() });

	await import('./popup');
	document.dispatchEvent(new Event('DOMContentLoaded'));
	await vi.waitFor(() => expect(releaseExtraction).toBeTypeOf('function'));
	const activate = (tabId: number) => { state.active = tabId; state.activate({ tabId, windowId: 7 }); };
	const field = (id: string) => document.querySelector<HTMLInputElement>('#' + id)!;
	const editor = document.querySelector<HTMLElement>('.clipper')!;

	activate(2);
	await vi.waitFor(() => expect(releaseTemplate).toBeTypeOf('function'));
	expect(editor.inert).toBe(true);
	field('clip-btn').click();
	field('save-image-archive').click();
	expect(document.getElementById('image-archive-status')?.textContent).toBe('paperEditorChanged');
	expect(openPaperDirectorySave).not.toHaveBeenCalled();

	activate(3);
	await vi.waitFor(() => expect(field('note-content-field').value).toBe('Body 3'));
	releaseTemplate('Body 2');
	releaseExtraction(paper(1));
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(editor.inert).toBe(false);
	expect(field('doi').value).toBe('10.1234/paper3');
	expect(field('note-name-field').value).toBe('Title 3');
	expect(field('note-content-field').value).toBe('Body 3');
	expect(vi.mocked(compileTemplate).mock.calls.map(call => call[1])).not.toContain('{{selector:.legacy-ai-context}}');

	expect(field('paper-save-methods').textContent).toBe('savePaperDirectory · paperMethodZip');
	expect(field('action-buttons').nextElementSibling).toBe(field('paper-save-methods'));
	field('note-content-field').value = 'Edited body 3';
	let saves = 0;
	for (const [button, format] of [['clip-btn', 'directory'], ['save-image-archive', 'zip'], ['clip-btn', 'directory']]) {
		field('use-default-paper-directory').checked = ++saves !== 3;
		field(button).click();
		await vi.waitFor(() => expect(openPaperDirectorySave).toHaveBeenLastCalledWith(expect.objectContaining({
			format, destination: saves === 3 ? 'once' : 'default', title: 'Title 3', source: url(3), markdown: 'Edited body 3',
			identity: { doi: '10.1234/paper3', published: '2026' },
		}), expect.any(Function)));
	}
	for (const useDefault of [true, false]) {
		field('use-default-paper-directory').checked = useDefault;
		document.querySelector<HTMLElement>('[data-i18n="saveMarkdownWithImageLinks"]')!.click();
		await vi.waitFor(() => expect(openPaperDirectorySave).toHaveBeenLastCalledWith(expect.objectContaining({
			format: 'markdown', destination: useDefault ? 'default' : 'once', markdown: 'Edited body 3',
		}), expect.any(Function)));
	}
	// The browser may have switched before its activation event reaches the panel.
	state.active = 4;
	field('clip-btn').click();
	await vi.waitFor(() => expect(document.getElementById('image-archive-status')?.textContent).toBe('paperEditorChanged'));
	expect(openPaperDirectorySave).toHaveBeenCalledTimes(5);

	// If the paper changes while a save is being prepared, discard that handoff.
	state.active = 3;
	let finishFrontmatter!: (value: string) => void;
	vi.mocked(generateFrontmatter).mockImplementationOnce(() => new Promise(resolve => { finishFrontmatter = resolve; }));
	field('save-image-archive').click();
	activate(4);
	await vi.waitFor(() => expect(field('note-content-field').value).toBe('Body 4'));
	finishFrontmatter('');
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(field('image-archive-status').textContent).toBe('');
	expect(field('paper-save-methods').textContent).toBe('');
	expect(openPaperDirectorySave).toHaveBeenCalledTimes(5);
	const copy = document.querySelector<HTMLElement>('.secondary-actions [data-i18n="paperCopyMarkdown"]')!;
	copy.click();
	await vi.waitFor(() => expect(field('image-archive-status').textContent).toBe('failedToCopyText'));
	expect(incrementStat).not.toHaveBeenCalledWith('copyToClipboard', expect.anything(), expect.anything(), url(4), 'Title 4');
	Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
	copy.click();
	await vi.waitFor(() => expect(incrementStat).toHaveBeenCalledWith('copyToClipboard', undefined, undefined, url(4), 'Title 4'));
	expect(field('note-content-field').value).toBe('Body 4');
});
