import dayjs from 'dayjs';
import { createMarkdownContent } from 'defuddle/full';
import { Template, Property } from '../types/types';
import { incrementStat, getClipHistory, type HistoryEntry } from '../utils/storage-utils';
import { generateFrontmatter } from '../utils/obsidian-note-creator';
import { extractPageContent, initializePageContent } from '../utils/content-extractor';
import { compileTemplate } from '../utils/template-compiler';
import { initializeIcons, getPropertyTypeIcon } from '../icons/icons';
import { findMatchingTemplate, initializeTriggers } from '../utils/triggers';
import { getLocalStorage, setLocalStorage, loadSettings, generalSettings, Settings } from '../utils/storage-utils';
import { escapeHtml, unescapeValue } from '../utils/string-utils';
import { loadTemplates, createDefaultTemplate } from '../managers/template-manager';
import browser from '../utils/browser-polyfill';
import { addBrowserClassToHtml, detectBrowser } from '../utils/browser-detection';
import { createElementWithClass } from '../utils/dom-utils';
import { adjustNoteNameHeight } from '../utils/ui-utils';
import { debugLog, isDebugMode } from '../utils/debug';
import { showVariables, initializeVariablesPanel, updateVariablesPanel } from '../managers/inspect-variables';
import { isBlankPage, isValidUrl, isRestrictedUrl } from '../utils/active-tab-manager';
import { debounce } from '../utils/debounce';
import { sanitizeFileName } from '../utils/string-utils';
import { collectImageSources } from '../utils/image-sources.mjs';
import { collectFigureLinks } from '../utils/figure-links';
import { resetAttachmentPicker, selectedPaperAttachments } from '../utils/attachment-picker';
import { paperIdentity, paperDirectoryFailure } from '../utils/paper-directory';
import { lastPaperSaveResult, openPaperDirectorySave, type PaperSaveFormat, type PaperSaveInput } from '../utils/paper-directory-handoff';
import { translatePage, getMessage, setupLanguageAndDirection } from '../utils/i18n';
import { formatPropertyValue } from '../utils/shared';
import { exportPageHtml } from '../utils/page-html-export';
import { notifySidePanelState, requestEmbeddedPanelToggle } from '../utils/side-panel-lifecycle';
import type { FormulaReport } from '../utils/paper-math.mjs';
import { ManualExportSnapshot, prepareManualExportChecks } from '../utils/manual-export-checks';
import { formatBibtex } from '../utils/paper-bibtex';

interface ReaderModeResponse {
	success: boolean;
	isActive: boolean;
}

let loadedSettings: Settings;
let currentTemplate: Template | null = null;
let templates: Template[] = [];
let currentVariables: { [key: string]: string } = {};
let currentTabId: number | undefined;
let editorWindowId: number | undefined;
let refreshController: AbortController | undefined;
type ExportPage = { data: NonNullable<Awaited<ReturnType<typeof extractPageContent>>>; source: string };
let manualExportPage: { tabId: number; data: ExportPage['data']; snapshot: ManualExportSnapshot } | undefined;


const isSidePanel = window.location.pathname.includes('side-panel.html');
const urlParams = new URLSearchParams(window.location.search);
const isIframe = urlParams.get('context') === 'iframe';

function getPropertiesFromDOM(): Property[] {
	return Array.from(document.querySelectorAll('.metadata-property input')).map(input => {
		const inputElement = input as HTMLInputElement;
		return {
			id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
			name: inputElement.id,
			value: inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value
		};
	}) as Property[];
}

// Helper function to get tab info from background script
type EditorTab = { id: number; url: string; windowId: number; active: boolean };
async function getTabInfo(tabId: number): Promise<EditorTab> {
	const response = await browser.runtime.sendMessage({ action: "getTabInfo", tabId }) as { success?: boolean; tab?: EditorTab; error?: string };
	if (!response || !response.success || !response.tab) {
		throw new Error((response && response.error) || 'Failed to get tab info');
	}
	// On the reader page, tabs.get() can't see the extension page URL
	// without the tabs permission. Fall back to the readerUrl param
	// passed through the iframe src.
	if (!response.tab.url) {
		const readerUrl = urlParams.get('readerUrl');
		if (readerUrl) {
			response.tab.url = readerUrl;
		}
	}
	return response.tab;
}

// Helper function to get current tab URL and title for stats
async function getCurrentTabInfo(): Promise<{ url: string; title?: string }> {
	if (!currentTabId) {
		return { url: '' };
	}
	
	try {
		const tab = await getTabInfo(currentTabId);
		// Try to get the title from the extracted content if available
		const page = manualExportPage;
		const extractedData = page?.tabId === tab.id && page.snapshot.source === tab.url ? page.data : undefined;
		return { 
			url: tab.url, 
			title: extractedData?.title || document.title 
		};
	} catch (error) {
		console.warn('Failed to get current tab info for stats:', error);
		return { url: '' };
	}
}

// Width is used to update the note name field height
let previousWidth = window.innerWidth;

function setPopupDimensions() {
	// Get the actual height of the popup after the browser has determined its maximum
	const actualHeight = document.documentElement.offsetHeight;
	
	// Calculate the viewport height and width
	const viewportHeight = window.innerHeight;
	const viewportWidth = window.innerWidth;
	
	// Use the smaller of the two heights
	const finalHeight = Math.min(actualHeight, viewportHeight);
	
	// Set the --popup-height CSS variable to the final height
	document.documentElement.style.setProperty('--chromium-popup-height', `${finalHeight}px`);

	// Check if the width has changed
	if (viewportWidth !== previousWidth) {
		previousWidth = viewportWidth;
		
		// Adjust the note name field height
		const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
		if (noteNameField) {
			adjustNoteNameHeight(noteNameField);
		}
	}
}

const debouncedSetPopupDimensions = debounce(setPopupDimensions, 100); // 100ms delay

async function initializeExtension(tabId: number) {
	try {
		document.getElementById('export-page-html')?.setAttribute('aria-label', getMessage('exportPageHtml'));
		
		// Setup language and RTL support
		await setupLanguageAndDirection();
		
		// First, add the browser class to allow browser-specific styles to apply
		await addBrowserClassToHtml();
		
		// Set an initial large height to allow the browser to determine the maximum height
		// This is necessary for browsers that allow scaling the popup via page zoom
		document.documentElement.style.setProperty('--chromium-popup-height', '2000px');
		
		// Use setTimeout to ensure the DOM has updated before we measure
		setTimeout(() => {
			setPopupDimensions();
		}, 0);

		debugLog('Settings', 'General settings:', loadedSettings);

		templates = await loadTemplates();
		debugLog('Templates', 'Loaded templates:', templates);

		if (templates.length === 0) {
			templates = [createDefaultTemplate()];
		}

		// Initialize triggers to speed up template matching
		initializeTriggers(templates);

		currentTemplate = templates[0];
		debugLog('Templates', 'Current template set to:', currentTemplate);

		// Setup message listeners
		setupMessageListeners();
		setupStorageListeners();

		await checkHighlighterModeState(tabId);

		return true;
	} catch (error) {
		console.error('Error initializing extension:', error);
		showError('failedToInitialize');
		return false;
	}
}

const debouncedHighlightRefresh = debounce(() => {
	if (currentTabId !== undefined) {
		const reuseTemplate = manualExportPage?.tabId === currentTabId;
		void refreshFields(currentTabId, { checkTemplateTriggers: !reuseTemplate, rebuildSkeleton: !reuseTemplate });
	}
}, 300);

function setupStorageListeners() {
	browser.storage.local.onChanged.addListener((changes) => {
		if (changes.history) renderSaveMethods(changes.history.newValue as HistoryEntry[] ?? []);
		if (changes.highlights) {
			debouncedHighlightRefresh();
		}
	});
}

function setupMessageListeners() {
	// A native panel belongs to one window and can outlive its article tab.
	if (isSidePanel && !isIframe) {
		browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
			if (windowId !== editorWindowId) return;
			currentTabId = tabId;
			void refreshFields(tabId);
		});
		browser.tabs.onUpdated.addListener((tabId, change) => {
			if (tabId !== currentTabId) return;
			if (change.status === 'loading') invalidateEditor();
			else if (change.url || change.status === 'complete') void refreshFields(tabId);
		});
	}
	browser.runtime.onMessage.addListener((request: any, sender: browser.Runtime.MessageSender, sendResponse: (response?: any) => void) => {
		if (request.action === "triggerQuickClip") {
			if (!manualExportPage || refreshController?.signal.aborted) {
				sendResponse({success: false});
				return;
			}
			saveActions[primarySaveBehavior()]().then(() => {
				sendResponse({success: true});
			}).catch((error) => {
				console.error('Quick clip failed:', error);
				sendResponse({success: false, error: error.message});
			});
			return true;
		} else if (request.action === "tabUrlChanged") {
			if (request.tabId === currentTabId) {
				if (currentTabId !== undefined) {
					refreshFields(currentTabId);
				}
			}
		} else if (request.action === "activeTabChanged") {
			// The native panel listens to its own window. Embedded editors stay bound to their host tab.
			if (!isSidePanel && !isIframe && request.windowId === editorWindowId) {
				invalidateEditor();
				currentTabId = request.tabId;
				if (request.isRestrictedUrl) {
					showError('pageCannotBeClipped');
				} else if (request.isValidUrl) {
					if (currentTabId !== undefined) {
						refreshFields(currentTabId); // Force template check when URL changes
					}
				} else if (request.isBlankPage) {
					showError('pageCannotBeClipped');
				} else {
					showError('onlyHttpSupported');
				}
			}
		} else if (request.action === "updatePopupHighlighterUI") {
			// This message is now handled by checkHighlighterModeState
		} else if (request.action === "highlighterModeChanged") {
			// This message is now handled by checkHighlighterModeState
		}
	});
}

document.addEventListener('DOMContentLoaded', async function() {
	await translatePage();
	const feedback = document.querySelector<HTMLAnchorElement>('.paper-feedback')!;
	const form = new URL('https://github.com/lljh2777-cyber/paper-clipper/issues/new');
	form.searchParams.set('body', getMessage('paperFeedbackBody'));
	feedback.href = form.href;
	loadedSettings = await loadSettings();
	initializeIcons(document.getElementById('popup-header') ?? document);
	const toolsButton = document.getElementById('popup-tools-btn') as HTMLButtonElement | null;
	const toolsMenu = document.getElementById('popup-tools-menu');
	const setToolsMenuOpen = (open: boolean) => {
		if (!toolsButton || !toolsMenu) return;
		toolsMenu.classList.toggle('show', open);
		toolsButton.setAttribute('aria-expanded', String(open));
	};
	if (toolsButton && toolsMenu) {
		toolsButton.title = getMessage('paperMoreTools');
		toolsButton.setAttribute('aria-label', toolsButton.title);
		toolsButton.addEventListener('click', (e) => {
			e.stopPropagation();
			document.getElementById('more-dropdown')?.classList.remove('show');
			setToolsMenuOpen(!toolsMenu.classList.contains('show'));
		});
		toolsMenu.addEventListener('click', (e) => {
			if ((e.target as Element).closest('.menu-item')) setToolsMenuOpen(false);
		});
		document.addEventListener('click', (e) => {
			if (!toolsMenu.contains(e.target as Node) && !toolsButton.contains(e.target as Node)) {
				setToolsMenuOpen(false);
			}
		});
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') setToolsMenuOpen(false);
		});
	}
	const exportButton = document.getElementById('export-page-html') as HTMLButtonElement | null;
	if (exportButton) {
		exportButton.title = getMessage('exportPageHtml');
		exportButton.setAttribute('aria-label', exportButton.title);
		initializeIcons(exportButton);
		exportButton.addEventListener('click', handleExportPageHtml);
	}
	if (isIframe) {
		document.documentElement.classList.add('is-embedded');
	}

	try {
		// Resolve a native panel in its own window; embedded editors resolve through their sender tab.
		const response: { tabId?: number; error?: string } = isSidePanel && !isIframe
			? { tabId: (await browser.tabs.query({ currentWindow: true, active: true }))[0]?.id }
			: await browser.runtime.sendMessage({ action: "getActiveTab" }) as { tabId?: number; error?: string };
		if (!response || response.error || !response.tabId) {
			showError(getMessage('pleaseReload'));
			return;
		}
		
		currentTabId = response.tabId;
		if (exportButton) exportButton.disabled = false;
		const tab = await getTabInfo(currentTabId);
		editorWindowId = tab.windowId;
		const currentBrowser = await detectBrowser();
		const isMobile = currentBrowser === 'mobile-safari';

		const openBehavior: Settings['openBehavior'] = isMobile && loadedSettings.openBehavior !== 'reader' ? 'popup' : loadedSettings.openBehavior;

		// Check if we should open in an iframe, but only if the URL is valid
		if (isValidUrl(tab.url) && !isBlankPage(tab.url) && openBehavior === 'embedded' && !isIframe && !isSidePanel) {
			try {
				const response = await browser.runtime.sendMessage({ action: "getActiveTabAndToggleIframe" }) as { success?: boolean; error?: string };
				if (response && response.success) {
					window.close();
					return; // Exit script after closing the window
				} else if (response && response.error) {
					console.error('Error toggling iframe:', response.error);
					// If there's an error, we'll fall through and open the normal popup.
				}
			} catch (error) {
				console.error('Error toggling iframe:', error);
				// If there's an error, we'll fall through and open the normal popup.
			}
		}

		// Check if we should open in reader mode
		if (isValidUrl(tab.url) && !isBlankPage(tab.url) && openBehavior === 'reader' && !isIframe && !isSidePanel) {
			try {
				const response = await browser.runtime.sendMessage({
					action: "toggleReaderMode",
					tabId: currentTabId
				}) as ReaderModeResponse;
				if (response && response.success) {
					window.close();
					return;
				}
			} catch (error) {
				console.error('Error toggling reader mode:', error);
				// If there's an error, we'll fall through and open the normal popup.
			}
		}

		// Connect to the background script for communication
		browser.runtime.connect({ name: 'popup' });

		// Setup event listeners for popup buttons
		const refreshButton = document.getElementById('refresh-pane');
		if (refreshButton) {
			if (isIframe) {
				refreshButton.style.display = 'none';
			} else {
				refreshButton.addEventListener('click', (e) => {
					e.preventDefault();
					refreshPopup();
					initializeIcons(refreshButton);
				});
			}
		}
		const settingsButton = document.getElementById('open-settings');
		if (settingsButton) {
			settingsButton.addEventListener('click', async function() {
				try {
					await browser.runtime.sendMessage({ action: "openOptionsPage" });
					setTimeout(() => window.close(), 50);
				} catch (error) {
					console.error('Error opening options page:', error);
				}
			});
			initializeIcons(settingsButton);
		}

		// Initialize the rest of the popup
		if (currentTabId) {
			const initialized = await initializeExtension(currentTabId);
			if (!initialized) {
				return;
			}

			try {
				// DOM-dependent initializations
				initializeDestinationSwitch();
				populateTemplateDropdown();
				setupEventListeners(currentTabId);
				await initializeUI();

				determineMainAction();

				const showMoreActionsButton = document.getElementById('show-variables');
				if (showMoreActionsButton) {
					showMoreActionsButton.addEventListener('click', (e) => {
						e.preventDefault();
						showVariables();
					});
				}

				// An activation during startup may precede listener registration.
				if (isSidePanel && !isIframe) {
					const initial = refreshController;
					const [active] = await browser.tabs.query({ active: true, windowId: editorWindowId });
					if (refreshController === initial && active?.id !== undefined) currentTabId = active.id;
				}
				await refreshFields(currentTabId);
			} catch (error) {
				console.error('Error initializing popup:', error);
				showError(getMessage('pleaseReload'));
			}
		} else {
			showError(getMessage('pleaseReload'));
		}
	} catch (error) {
		console.error('Error getting active tab:', error);
		showError(getMessage('pleaseReload'));
	}
});

function setupEventListeners(tabId: number) {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown) {
		templateDropdown.addEventListener('change', function(this: HTMLSelectElement) {
			handleTemplateChange(this.value);
		});
	}

	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.addEventListener('input', () => adjustNoteNameHeight(noteNameField));
		noteNameField.addEventListener('keydown', function(e) {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
			}
		});
	}

	const highlighterModeButton = document.getElementById('highlighter-mode');
	if (highlighterModeButton) {
		highlighterModeButton.addEventListener('click', () => toggleHighlighterMode(tabId));
	}

	const embeddedModeButton = document.getElementById('embedded-mode');
		if (embeddedModeButton) {
			embeddedModeButton.addEventListener('click', async function() {
				try {
					const result = await requestEmbeddedPanelToggle();
					if (result === 'invalidated') {
						showSaveStatus(getMessage('embeddedPanelReloadRequired'));
						return;
					}
					setTimeout(() => window.close(), 50);
				} catch (error) {
					console.error('Error toggling embedded iframe:', error);
					showSaveStatus(getMessage('embeddedPanelToggleFailed'));
				}
			});
		}

	const moreButton = document.getElementById('more-btn');
	const moreDropdown = document.getElementById('more-dropdown');
	const copyContentButton = document.getElementById('copy-content');
	const shareContentButton = document.getElementById('share-content');

	if (moreButton && moreDropdown) {
		moreButton.addEventListener('click', (e) => {
			e.stopPropagation();
			const toolsMenu = document.getElementById('popup-tools-menu');
			if (toolsMenu?.classList.contains('show')) {
				toolsMenu.classList.remove('show');
				document.getElementById('popup-tools-btn')?.setAttribute('aria-expanded', 'false');
			}
			moreDropdown.classList.toggle('show');
		});

		// Close dropdown when clicking outside
		document.addEventListener('click', (e) => {
			if (!moreButton.contains(e.target as Node)) {
				moreDropdown.classList.remove('show');
			}
		});
	}

	if (copyContentButton) copyContentButton.addEventListener('click', copyContent);

	const shareButtons = document.querySelectorAll('.share-content');
	if (shareButtons) {
		shareButtons.forEach(button => {
			button.addEventListener('click', async (e) => {
				// Get content synchronously
				const properties = getPropertiesFromDOM();

				const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
				
				// Use Promise.all to prepare the data
				Promise.all([
					generateFrontmatter(properties),
					Promise.resolve(noteContentField.value)
				]).then(([frontmatter, noteContent]) => {
					const fileContent = frontmatter + noteContent;
					
					// Call share directly from the click handler
					const noteNameField = document.getElementById('note-name-field') as HTMLInputElement;
					let fileName = noteNameField?.value || 'untitled';
					fileName = sanitizeFileName(fileName);
					if (!fileName.toLowerCase().endsWith('.md')) {
						fileName += '.md';
					}

					if (navigator.share && navigator.canShare) {
						const blob = new Blob([fileContent], { type: 'text/markdown;charset=utf-8' });
						const file = new File([blob], fileName, { type: 'text/markdown;charset=utf-8' });
						
						const shareData = {
							files: [file],
							text: 'Shared from Paper Clipper'
						};

						if (navigator.canShare(shareData)) {
							navigator.share(shareData)
								.then(async () => {
									const tabInfo = await getCurrentTabInfo();
									await incrementStat('share', undefined, undefined, tabInfo.url, tabInfo.title);
									const moreDropdown = document.getElementById('more-dropdown');
									if (moreDropdown) {
											moreDropdown.classList.remove('show');
									}
								})
								.catch((error) => {
									console.error('Error sharing:', error);
								});
						}
					}
				});
			});
		});
	}

	const shareButtonElements = document.querySelectorAll('.share-content');
	if (shareButtonElements.length > 0) {
		detectBrowser().then(browser => {
			const isSafariBrowser = ['safari', 'mobile-safari', 'ipad-os'].includes(browser);
			if (!isSafariBrowser || !navigator.share || !navigator.canShare) {
				shareButtonElements.forEach(button => {
					const parentElement = button.closest('.share-btn, .menu-item') as HTMLElement;
					if (parentElement) {
						parentElement.style.display = 'none';
					}
				});
			} else {
				// Test if we can share files (only on Safari)
				try {
					const testFile = new File(["test"], "test.txt", { type: "text/plain" });
					const testShare = { files: [testFile] };
					if (!navigator.canShare(testShare)) {
						throw new Error('canShare returned false');
					}
				} catch {
					shareButtonElements.forEach(button => {
						const parentElement = button.closest('.share-btn, .menu-item') as HTMLElement;
						if (parentElement) {
							parentElement.style.display = 'none';
						}
					});
				}
			}
		});
	}

	const readerModeButton = document.getElementById('reader-mode');
	if (readerModeButton) {
		readerModeButton.addEventListener('click', () => toggleReaderMode(tabId));
		checkReaderModeState(tabId);
	}
}

async function initializeUI() {
	const clipButton = document.getElementById('clip-btn');
	if (clipButton) {
		clipButton.focus();
	} else {
		console.warn('Clip button not found');
	}

	const showMoreActionsButton = document.getElementById('show-variables') as HTMLElement;
	const variablesPanel = document.createElement('div');
	variablesPanel.className = 'variables-panel';
	document.body.appendChild(variablesPanel);

	if (showMoreActionsButton) {
		showMoreActionsButton.addEventListener('click', async (e) => {
			e.preventDefault();
			// Initialize the variables panel with the latest data
			initializeVariablesPanel(variablesPanel, currentTemplate, currentVariables);
			await showVariables();
		});
	}

	if (isSidePanel) {
		void notifySidePanelState(true);
		
		window.addEventListener('unload', () => {
			void notifySidePanelState(false);
		});
	}
}

function showError(messageKey: string, message = getMessage(messageKey)): void {
	const errorMessage = document.querySelector('.error-message') as HTMLElement;
	const clipper = document.querySelector('.clipper') as HTMLElement;

	if (errorMessage && clipper) {
		errorMessage.textContent = message;
		errorMessage.style.display = 'flex';
		clipper.style.display = 'none';

		document.body.classList.add('has-error');
	}
}
function clearError(): void {
	const errorMessage = document.querySelector('.error-message') as HTMLElement;
	const clipper = document.querySelector('.clipper') as HTMLElement;

	if (errorMessage && clipper) {
		errorMessage.style.display = 'none';
		clipper.style.removeProperty('display');

		document.body.classList.remove('has-error');
	}
}

function logError(message: string, error?: any): void {
	console.error(message, error);
	showError(message);
}

function invalidateEditor() {
	refreshController?.abort();
	manualExportPage = undefined;
	renderSaveMethods([]);
	showSaveStatus('');
	resetAttachmentPicker();
	const editor = document.querySelector<HTMLElement>('.clipper');
	if (editor) editor.inert = true;
}

async function refreshFields(tabId: number, { checkTemplateTriggers = true, rebuildSkeleton = true }: { checkTemplateTriggers?: boolean; rebuildSkeleton?: boolean } = {}) {
	invalidateEditor();
	refreshController = new AbortController();
	const { signal } = refreshController;
	if (templates.length === 0) {
		console.warn('No templates available');
		showError('noTemplates');
		return;
	}

	try {
		const tab = await getTabInfo(tabId);
		if (signal.aborted) return;
		if (!tab.url || isBlankPage(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}
		if (!isValidUrl(tab.url)) {
			showError('onlyHttpSupported');
			return;
		}
		if (isRestrictedUrl(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}

		const extractedData = await extractPageContent(tabId);
		if (signal.aborted) return;
		if (extractedData?.sourceUrl !== tab.url) throw new Error('paperEditorChanged');

		const matched = checkTemplateTriggers
			? await findMatchingTemplate(tab.url, async () => extractedData.schemaOrgData)
			: undefined;
		if (signal.aborted) return;
		const template = matched ?? currentTemplate;
		if (!template) throw new Error('noTemplates');
		const currentUrl = tab.url;
		const initializedContent = await initializePageContent(
			extractedData.content,
			extractedData.selectedHtml,
			extractedData.extractedContent,
			currentUrl,
			extractedData.schemaOrgData,
			extractedData.fullHtml,
			extractedData.highlights || [],
			extractedData.title,
			extractedData.author,
			extractedData.description,
			extractedData.favicon,
			extractedData.image,
			extractedData.published,
			extractedData.site,
			extractedData.wordCount,
			extractedData.language || '',
			extractedData.metaTags
		);
		if (signal.aborted) return;
		if (!initializedContent) throw new Error('Unable to initialize page content.');
		await fillTemplateFieldValues(tabId, template, initializedContent.currentVariables,
			{ data: extractedData, source: currentUrl }, signal, rebuildSkeleton);
		if (!signal.aborted) updateVariablesPanel(template, currentVariables);
	} catch (error) {
		if (signal.aborted) return;
		invalidateEditor();
		if (error instanceof Error && 'code' in error && error.code === 'formula-preservation') {
			console.warn('[Paper Clipper] Extraction stopped:', error.message);
			const report = (error as Error & { formulaPreservation?: FormulaReport }).formulaPreservation;
			const first = report?.unsupported[0];
			if (first) {
				const reasons: Record<string, string> = {
					'Lazy placeholder has no MathML or TeX source': 'paperMathLazy',
					'Invalid MathML XML': 'paperMathXml',
					'Unsupported MathML structure or namespace': 'paperMathStructure',
					'MathJax input exceeds snapshot limit': 'paperMathLimit',
				};
				const reason = reasons[first.reason] ? getMessage(reasons[first.reason]) : first.reason.slice(0, 100);
				showError('paperMathStopped', getMessage('paperMathStopped', [String(report.unsupported.length),
					String(first.position), first.id.slice(0, 48), reason]));
			} else showError('', error.message);
			return;
		} else console.error('Error refreshing fields:', error);
		const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
		showError(errorMessage);
	}
}

function updateTemplateDropdown() {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown && currentTemplate) {
		templateDropdown.value = currentTemplate.id;
	}
}

function populateTemplateDropdown() {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown && currentTemplate) {
		// Clear existing options
		templateDropdown.textContent = '';
		templates.forEach((template: Template) => {
			const option = document.createElement('option');
			option.value = template.id;
			option.textContent = template.name;
			templateDropdown.appendChild(option);
		});
		templateDropdown.value = currentTemplate.id;
	}
}

function buildTemplateFieldsSkeleton(template: Template | null) {
	if (!template) return;

	const existingTemplateProperties = document.querySelector('.metadata-properties') as HTMLElement;

	const newTemplateProperties = createElementWithClass('div', 'metadata-properties');

	if (Array.isArray(template.properties)) {
		for (const property of template.properties) {
			const propertyDiv = createElementWithClass('div', 'metadata-property');
			const propertyType = generalSettings.propertyTypes.find(p => p.name === property.name)?.type || 'text';

			// Create metadata property key container
			const metadataPropertyKey = document.createElement('div');
			metadataPropertyKey.className = 'metadata-property-key';

			const propertyIconSpan = document.createElement('span');
			propertyIconSpan.className = 'metadata-property-icon';
			const iconElement = document.createElement('i');
			iconElement.setAttribute('data-lucide', getPropertyTypeIcon(propertyType));
			propertyIconSpan.appendChild(iconElement);

			const propertyLabel = document.createElement('label');
			propertyLabel.setAttribute('for', property.name);
			propertyLabel.textContent = property.name;

			metadataPropertyKey.appendChild(propertyIconSpan);
			metadataPropertyKey.appendChild(propertyLabel);

			// Create metadata property value container with empty input
			const metadataPropertyValue = document.createElement('div');
			metadataPropertyValue.className = 'metadata-property-value';

			const inputElement = document.createElement('input');
			inputElement.id = property.name;
			inputElement.setAttribute('data-type', propertyType);
			inputElement.setAttribute('data-template-value', property.value);
			inputElement.type = propertyType === 'checkbox' ? 'checkbox' : 'text';

			metadataPropertyValue.appendChild(inputElement);

			propertyDiv.appendChild(metadataPropertyKey);
			propertyDiv.appendChild(metadataPropertyValue);
			newTemplateProperties.appendChild(propertyDiv);
		}
	}

	// Replace the existing element
	if (existingTemplateProperties && existingTemplateProperties.parentNode) {
		existingTemplateProperties.parentNode.replaceChild(newTemplateProperties, existingTemplateProperties);
		existingTemplateProperties.remove();
	}

	initializeIcons(newTemplateProperties);

	// Set up note name and path fields with template values
	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.setAttribute('data-template-value', template.noteNameFormat);
	}

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	if (noteContentField) {
		noteContentField.setAttribute('data-template-value', template.noteContentFormat || '');
	}
}

async function fillTemplateFieldValues(currentTabId: number, template: Template, variables: { [key: string]: string }, exportPage: ExportPage, signal: AbortSignal, rebuildSkeleton: boolean) {

	const currentUrl = exportPage.source;

	if (!Array.isArray(template.properties)) throw new Error('failedToExtractContent');

	// Compile all templates in parallel
	const [compiledPropertyValues, formattedNoteName, formattedContent] = await Promise.all([
		Promise.all(template.properties.map(property =>
			compileTemplate(currentTabId!, unescapeValue(property.value), variables, currentUrl)
		)),
		compileTemplate(currentTabId!, template.noteNameFormat, variables, currentUrl),
		template.noteContentFormat
			? compileTemplate(currentTabId!, template.noteContentFormat, variables, currentUrl)
			: Promise.resolve('')
	]);

	if (signal.aborted) return;
	currentVariables = variables;
	currentTemplate = template;
	updateTemplateDropdown();
	if (rebuildSkeleton) {
		buildTemplateFieldsSkeleton(template);
		setupMetadataToggle();
	}
	// Fill property values into existing DOM elements
	for (let i = 0; i < template.properties.length; i++) {
		const property = template.properties[i];
		const inputElement = document.getElementById(property.name) as HTMLInputElement;
		if (!inputElement) continue;

		let value = compiledPropertyValues[i];
		const propertyType = inputElement.getAttribute('data-type') || 'text';

		// Apply type-specific parsing
		value = formatPropertyValue(value, propertyType, property.value);

		if (propertyType === 'checkbox') {
			inputElement.checked = value === 'true';
		} else {
			inputElement.value = value;
		}
	}

	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.value = formattedNoteName.trim();
		adjustNoteNameHeight(noteNameField);
	}

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	if (noteContentField) {
		noteContentField.value = template.noteContentFormat ? formattedContent : '';
		// Bind checks, identity and image hints to the same capture that filled the
		// editor. A later save must not silently re-extract a changed page.
		manualExportPage = { tabId: currentTabId, data: exportPage.data, snapshot: {
			document: new DOMParser().parseFromString(exportPage.data.fullHtml, 'text/html'), source: exportPage.source,
			extractedMarkdown: createMarkdownContent(exportPage.data.content, exportPage.source), templateMarkdown: noteContentField.value,
		} };
		void restoreSaveFeedback(manualExportPage);
		resetAttachmentPicker(manualExportPage.snapshot);
		clearError();
		document.querySelector<HTMLElement>('.clipper')!.inert = false;
	}
	if (isDebugMode()) {
		const replacedTemplate = await getReplacedTemplate(template, variables, currentTabId!, currentUrl);
		debugLog('Variables', 'Current template with replaced variables:', JSON.stringify(replacedTemplate, null, 2));
	}
}

function setupMetadataToggle() {
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	
	if (metadataHeader && metadataProperties) {
		metadataHeader.removeEventListener('click', toggleMetadataProperties);
		metadataHeader.addEventListener('click', toggleMetadataProperties);

		// Set initial state
		getLocalStorage('propertiesCollapsed').then((isCollapsed) => {
			if (isCollapsed === undefined) {
				// If the value is not set, default to not collapsed
				updateMetadataToggleState(false); 
			} else {
				updateMetadataToggleState(isCollapsed);
			}
		});
	}
}

function toggleMetadataProperties() {
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	
	if (metadataProperties && metadataHeader) {
		const isCollapsed = metadataProperties.classList.toggle('collapsed');
		metadataHeader.classList.toggle('collapsed');
		setLocalStorage('propertiesCollapsed', isCollapsed);
	}
}

function updateMetadataToggleState(isCollapsed: boolean) {
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	
	if (metadataProperties && metadataHeader) {
		if (isCollapsed) {
			metadataProperties.classList.add('collapsed');
			metadataHeader.classList.add('collapsed');
		} else {
			metadataProperties.classList.remove('collapsed');
			metadataHeader.classList.remove('collapsed');
		}
	}
}

async function getReplacedTemplate(template: Template, variables: { [key: string]: string }, tabId: number, currentUrl: string): Promise<any> {
	const replacedTemplate: any = {
		schemaVersion: "0.1.0",
		name: template.name,
		behavior: template.behavior,
		noteNameFormat: await compileTemplate(tabId, template.noteNameFormat, variables, currentUrl),
		path: template.path,
		noteContentFormat: await compileTemplate(tabId, template.noteContentFormat, variables, currentUrl),
		properties: [],
		triggers: template.triggers
	};

	for (const prop of template.properties) {
		const replacedProp: Property = {
			id: prop.id,
			name: prop.name,
			value: await compileTemplate(tabId, prop.value, variables, currentUrl)
		};
		replacedTemplate.properties.push(replacedProp);
	}

	return replacedTemplate;
}

function initializeDestinationSwitch() {
	const toggle = document.querySelector<HTMLInputElement>('#use-default-paper-directory')!;
	toggle.checked = loadedSettings.useDefaultPaperDirectory !== false;
	toggle.onchange = async () => {
		const selected = toggle.checked;
		try {
			await browser.storage.sync.set({ useDefaultPaperDirectory: selected });
		} catch {
			toggle.checked = !selected;
			showSaveStatus(getMessage('paperDestinationSettingFailed'));
		}
	};
	browser.storage.sync.onChanged.addListener(changes => {
		if (changes.useDefaultPaperDirectory) toggle.checked = changes.useDefaultPaperDirectory.newValue !== false;
	});
}

function refreshPopup() {
	window.location.reload();
}

function handleTemplateChange(templateId: string) {
	currentTemplate = templates.find(t => t.id === templateId) || templates[0];
	refreshFields(currentTabId!, { checkTemplateTriggers: false });
}

function setReaderButtonState(isActive: boolean) {
	const readerButton = document.getElementById('reader-mode');
	if (readerButton) {
		readerButton.classList.toggle('active', isActive);
		readerButton.setAttribute('aria-pressed', isActive.toString());
		readerButton.title = isActive ? getMessage('disableReader') : getMessage('enableReader');
	}
}

async function checkReaderModeState(tabId: number) {
	try {
		// When embedded in a reader.html page, we know reader mode is active
		if (urlParams.get('readerUrl')) {
			setReaderButtonState(true);
			return;
		}

		// Query the actual page DOM via content script rather than
		// relying on background state, which can be stale across tabs
		const response = await browser.runtime.sendMessage({
			action: "sendMessageToTab",
			tabId: tabId,
			message: { action: "getReaderModeState" }
		}) as { isActive: boolean } | undefined;

		setReaderButtonState(response?.isActive ?? false);
	} catch (error) {
		// Tab may not have content script loaded yet
		console.error('Error checking reader mode state:', error);
	}
}

async function checkHighlighterModeState(tabId: number) {
	try {
		const response = await browser.runtime.sendMessage({
			action: "getHighlighterMode",
			tabId: tabId
		}) as { isActive: boolean };

		const isHighlighterMode = response.isActive;
		
		loadedSettings = await loadSettings();
		
		updateHighlighterModeUI(isHighlighterMode);
	} catch (error) {
		console.error('Error checking highlighter mode state:', error);
		// If there's an error, assume highlighter mode is off
		updateHighlighterModeUI(false);
	}
}

async function toggleHighlighterMode(tabId: number) {
	try {
		const response = await browser.runtime.sendMessage({
			action: "toggleHighlighterMode",
			tabId: tabId
		}) as { success: boolean, isActive: boolean, error?: string };

		if (response && response.success) {
			const isNowActive = response.isActive;
			updateHighlighterModeUI(isNowActive);

			// Close the popup if highlighter mode is turned on and not in side panel
			if (isNowActive && !isSidePanel && !isIframe) {
				setTimeout(() => window.close(), 50);
			}
		} else {
			throw new Error(response.error || "Failed to toggle highlighter mode.");
		}
	} catch (error) {
		console.error('Error toggling highlighter mode:', error);
		showError('failedToToggleHighlighter');
	}
}

function updateHighlighterModeUI(isActive: boolean) {
	const highlighterModeButton = document.getElementById('highlighter-mode');
	if (highlighterModeButton) {
		if (generalSettings.highlighterEnabled) {
			highlighterModeButton.style.display = 'flex';
			highlighterModeButton.classList.toggle('active', isActive);
			highlighterModeButton.setAttribute('aria-pressed', isActive.toString());
			highlighterModeButton.title = isActive ? getMessage('disableHighlighter') : getMessage('highlighterOn');
		} else {
			highlighterModeButton.style.display = 'none';
		}
	}
}

async function toggleReaderMode(tabId: number) {
	try {
		// When embedded in a reader.html page, pass the reader URL
		// so the background can navigate away even without tab URL access
		const response = await browser.runtime.sendMessage({
			action: "toggleReaderMode",
			tabId: tabId,
			readerUrl: urlParams.get('readerUrl') || undefined
		}) as ReaderModeResponse;

		if (response && response.success) {
			setReaderButtonState(response.isActive ?? false);
		}

		// Close the popup if not in side panel or iframe
		if (!isSidePanel && !isIframe) {
			window.close();
		}
	} catch (error) {
		console.error('Error toggling reader mode:', error);
		showError('failedToToggleReaderMode');
	}
}

async function copyToClipboard(content: string, page: NonNullable<typeof manualExportPage>): Promise<boolean> {
	if (page === manualExportPage) showSaveStatus('');
	try {
		try {
			await navigator.clipboard.writeText(content);
		} catch {
			const response = await browser.runtime.sendMessage({ action: 'copy-to-clipboard', text: content }) as { success?: boolean } | undefined;
			if (!response?.success) throw new Error('Clipboard write failed');
		}

		await incrementStat('copyToClipboard', undefined, undefined, page.snapshot.source, page.data.title)
			.catch(error => console.warn('Could not record clipboard history', error));
		return true;
	} catch (error) {
		console.error('Failed to copy to clipboard:', error);
		if (page === manualExportPage) showSaveStatus(getMessage('failedToCopyText'));
		return false;
	}
}

async function handleExportPageHtml() {
	const button = document.getElementById('export-page-html') as HTMLButtonElement;
	const status = document.getElementById('html-export-status') as HTMLElement;
	if (button.disabled) return;
	button.disabled = true;
	button.setAttribute('aria-busy', 'true');
	status.hidden = false;
	status.textContent = getMessage('htmlExportInProgress');
	status.classList.remove('is-error');
	try {
		const tabId = currentTabId;
		if (tabId === undefined) throw new Error('htmlExportUnsupportedPage');
		const tab = await getTabInfo(tabId);
		await exportPageHtml(tabId, tab.url);
		status.textContent = getMessage('htmlExportDownloadsStarted');
	} catch (error) {
		console.error('Failed to export page HTML:', error);
		const knownErrors = ['htmlExportUnsupportedPage', 'htmlExportExitReader', 'htmlExportTooLarge', 'htmlExportPageChanged'];
		const key = error instanceof Error && knownErrors.includes(error.message) ? error.message : 'htmlExportFailed';
		status.textContent = getMessage(key);
		status.classList.add('is-error');
	} finally {
		button.disabled = false;
		button.removeAttribute('aria-busy');
	}
}

let imageArchiveBusy = false;
const methodLabels = {
	directory: 'savePaperDirectory', 'chosen-directory': 'savePaperDirectory', markdown: 'paperMethodMarkdownSaved', zip: 'paperMethodZip',
	saveFile: 'paperMethodMarkdown', copyToClipboard: 'paperMethodClipboard',
} as const;
let historyRevision = 0;
function renderSaveMethods(history: HistoryEntry[]) {
	historyRevision++;
	const field = document.getElementById('paper-save-methods')!;
	const source = manualExportPage?.snapshot.source;
	const actions = new Set(history.filter(entry => entry.url === source).map(entry => entry.action));
	const methods = Object.entries(methodLabels).filter(([action]) => actions.has(action as HistoryEntry['action']));
	field.textContent = methods.length ? getMessage('paperSaveMethods', [...new Set(methods.map(([, key]) => getMessage(key)))].join(' · ')) : '';
}
function showSaveStatus(message: string, expanded = true) {
	const details = document.querySelector<HTMLDetailsElement>('#paper-save-details')!;
	details.hidden = !message;
	details.open = !!message && expanded;
	document.getElementById('image-archive-status')!.textContent = message;
}
async function restoreSaveFeedback(page: NonNullable<typeof manualExportPage>) {
	const revision = historyRevision;
	const [history, detail] = await Promise.all([getClipHistory().catch(() => []), lastPaperSaveResult(page.snapshot.source)]);
	if (page !== manualExportPage) return;
	if (revision === historyRevision) renderSaveMethods(history);
	if (detail && !document.getElementById('image-archive-status')!.textContent) showSaveStatus(detail, false);
}

function buildCurrentBibtex(page: NonNullable<typeof manualExportPage>, title: string, properties: Property[], explicitDoi?: string | null): string {
	let doi = explicitDoi;
	if (doi === undefined) {
		try {
			doi = paperIdentity(page.data.metaTags, properties, page.snapshot.source, page.data.published).doi;
		} catch {
			doi = null;
		}
	}
	return formatBibtex({
		title: title || page.data.title,
		author: page.data.author,
		published: page.data.published,
		source: page.snapshot.source,
		doi,
		metaTags: page.data.metaTags,
		properties,
	});
}

async function handleManualSave(format: PaperSaveFormat) {
	if (imageArchiveBusy) return;
	imageArchiveBusy = true;
	const origin = manualExportPage?.snapshot.source;
	const useDefault = document.querySelector<HTMLInputElement>('#use-default-paper-directory')!.checked;
	const status = (message: string, expanded = true) => {
		if (origin === manualExportPage?.snapshot.source) showSaveStatus(message, expanded);
	};
	document.getElementById('more-dropdown')?.classList.remove('show');
	status(getMessage('paperDirectorySaving'));
	try {
		// Every editor surface hands off the same immutable snapshot. Images and
		// writes belong to the save page, so closing a popup cannot interrupt them.
		const markdown = (document.getElementById('note-content-field') as HTMLTextAreaElement).value;
		const title = (document.getElementById('note-name-field') as HTMLInputElement).value;
		const properties = getPropertiesFromDOM();
		const page = manualExportPage;
		if (!page) {
			status(getMessage('paperEditorChanged'));
			return;
		}
		const frontmatter = await generateFrontmatter(properties);
		const source = page.snapshot.source;
		const input: PaperSaveInput = { format, destination: useDefault ? 'default' : 'once', markdown: frontmatter + markdown,
			title, source, identity: { doi: null, published: null } };
		if (format !== 'markdown') {
			input.identity = paperIdentity(page.data.metaTags, properties, source, page.data.published);
			input.imageSources = collectImageSources(page.snapshot.document, source);
			input.attachments = selectedPaperAttachments();
			input.checkContext = await prepareManualExportChecks(page.snapshot, input.markdown);
			input.figureLinks = collectFigureLinks(page.snapshot.document, source, input.markdown);
			input.bibtex = buildCurrentBibtex(page, title, properties, input.identity.doi);
		}
		const tab = await getTabInfo(page.tabId);
		if (page !== manualExportPage || currentTabId !== page.tabId || tab.url !== source || (isSidePanel && !isIframe && (!tab.active || tab.windowId !== editorWindowId))) {
			status(getMessage('paperEditorChanged'));
			return;
		}
		let receivedStatus = false;
		const job = await openPaperDirectorySave(input, update => {
			receivedStatus = true;
			status(update.state === 'closed' ? getMessage('paperDirectoryClosed') : update.message, update.state !== 'saved');
		});
		if (!receivedStatus) status(getMessage('paperDirectoryHandedOff'));
		await job.finished;
	} catch (error) {
		const failure = paperDirectoryFailure(error);
		status(getMessage(failure.key, failure.detail));
	} finally { imageArchiveBusy = false; }
}

const saveActions = {
	savePaperDirectory: () => handleManualSave('directory'),
	saveImageArchive: () => handleManualSave('zip'),
	saveMarkdownWithImageLinks: () => handleManualSave('markdown'),
	copyToClipboard: copyContent
};

const saveLabel = (action: Settings['saveBehavior']) => action === 'copyToClipboard' ? 'paperCopyMarkdown' : action;

function primarySaveBehavior(): Settings['saveBehavior'] {
	const behavior = loadedSettings?.saveBehavior;
	return behavior ?? 'savePaperDirectory';
}

function determineMainAction() {
	const mainButton = document.getElementById('clip-btn');
	const moreDropdown = document.getElementById('more-dropdown');
	const secondaryActions = moreDropdown?.querySelector('.secondary-actions');
	if (!mainButton || !secondaryActions) return;

	// Clear existing secondary actions
	secondaryActions.textContent = '';

	const primary = primarySaveBehavior();
	mainButton.textContent = getMessage(saveLabel(primary));
	mainButton.onclick = saveActions[primary];
	for (const action of ['savePaperDirectory', 'saveImageArchive', 'saveMarkdownWithImageLinks', 'copyToClipboard'] as const) {
		if (action !== primary) {
			addSecondaryMenuItem(secondaryActions, {
				id: action === 'saveImageArchive' ? 'save-image-archive' : action === 'savePaperDirectory' ? 'save-paper-directory' : undefined,
				icon: getActionIcon(action),
				i18nKey: saveLabel(action),
				handler: saveActions[action],
			});
		}
	}
	addSecondaryMenuItem(secondaryActions, {
		id: 'copy-bibtex',
		icon: 'quote',
		i18nKey: 'paperCopyBibtex',
		handler: copyBibtex,
	});
}

function addSecondaryMenuItem(container: Element, options: { id?: string; icon: string; i18nKey: string; handler: () => void }) {
	const menuItem = document.createElement('div');
	menuItem.className = 'menu-item';
	if (options.id) menuItem.id = options.id;
	menuItem.setAttribute('role', 'button');
	menuItem.tabIndex = 0;
	menuItem.addEventListener('keydown', event => {
		if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); options.handler(); }
	});

	// Create menu item icon container
	const menuItemIcon = document.createElement('div');
	menuItemIcon.className = 'menu-item-icon';
	
	const iconElement = document.createElement('i');
	iconElement.setAttribute('data-lucide', options.icon);
	menuItemIcon.appendChild(iconElement);
	
	// Create menu item title
	const menuItemTitle = document.createElement('div');
	menuItemTitle.className = 'menu-item-title';
	menuItemTitle.setAttribute('data-i18n', options.i18nKey);
	menuItemTitle.textContent = getMessage(options.i18nKey);
	
	// Assemble menu item
	menuItem.appendChild(menuItemIcon);
	menuItem.appendChild(menuItemTitle);
	
	menuItem.addEventListener('click', options.handler);
	container.appendChild(menuItem);
	initializeIcons(menuItem);
}

function getActionIcon(actionType: string): string {
	switch (actionType) {
		case 'copyToClipboard': return 'copy';
		case 'saveMarkdownWithImageLinks': return 'file-down';
		case 'saveImageArchive': return 'archive';
		case 'savePaperDirectory': return 'folder-open';
		default: return 'plus';
	}
}

async function copyContent() {
	const page = manualExportPage;
	if (!page) return;
	const properties = getPropertiesFromDOM();

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	const content = noteContentField.value;
	const frontmatter = await generateFrontmatter(properties);
	await copyToClipboard(frontmatter + content, page);
}

async function copyBibtex() {
	const page = manualExportPage;
	if (!page) return;
	document.getElementById('more-dropdown')?.classList.remove('show');
	const properties = getPropertiesFromDOM();
	const title = (document.getElementById('note-name-field') as HTMLInputElement).value;
	const bibtex = buildCurrentBibtex(page, title, properties);
	if (await copyToClipboard(bibtex, page) && page === manualExportPage) {
		showSaveStatus(getMessage('paperBibtexCopied'));
	}
}

// Update the resize event listener to use the debounced version
window.addEventListener('resize', debouncedSetPopupDimensions);
