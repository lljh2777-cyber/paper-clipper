import { collectPaperAttachments, type PaperAttachment } from './paper-attachments';
import { getMessage } from './i18n';
import { collectExtendedPaperContent, excludeExtendedPaperContent, extendedTableLink, isStandalonePaperTable } from './extended-paper-content';
import { inspectArchiveMarkdown } from './image-archive';
import { isHighWirePreprintHost } from './image-sources.mjs';

let candidates: PaperAttachment[] = [];
let extended: ReturnType<typeof collectExtendedPaperContent> | undefined;
let listeners: AbortController | undefined;
let previewTimer: ReturnType<typeof setTimeout> | undefined;

export function resetAttachmentPicker(snapshot?: { document: Document; source: string }, editor?: HTMLTextAreaElement) {
	listeners?.abort();
	clearTimeout(previewTimer);
	document.getElementById('paper-attachments')?.remove();
	document.getElementById('paper-extended-content')?.remove();
	const counter = document.getElementById('paper-archive-count');
	if (counter) counter.hidden = true;
	extended = snapshot ? collectExtendedPaperContent(snapshot.document, snapshot.source) : undefined;
	let includeExtended: HTMLInputElement | undefined;
	if (extended && (extended.images.size || extended.tables.size)) {
		const label = document.createElement('label'); label.id = 'paper-extended-content';
		includeExtended = document.createElement('input'); includeExtended.type = 'checkbox';
		label.append(includeExtended, getMessage('paperIncludeExtendedShort'));
		label.title = getMessage('paperIncludeExtendedContent');
		includeExtended.setAttribute('aria-label', label.title);
		(document.getElementById('paper-save-options') ?? document.querySelector('.clipper-footer'))?.prepend(label);
	}
	if (snapshot && editor && counter) {
		listeners = new AbortController();
		const update = () => {
			try {
				const selection = applyExtendedContentChoice(editor.value, snapshot.source);
				const { frontmatter, tree, urls } = inspectArchiveMarkdown(selection.markdown, snapshot.source);
				const body = selection.markdown.slice(frontmatter.length);
				const expandable = new Set(selection.includeTables && isHighWirePreprintHost(new URL(snapshot.source).hostname) ? extended?.tables.values() : []);
				const tableLinks = new Set<string>();
				let tableCount = 0;
				for (const node of tree.children) {
					const href = extendedTableLink(node, snapshot.source);
					if (href && expandable.has(href)) tableLinks.add(href);
					if ((node.type === 'html' || node.type === 'paragraph') && isStandalonePaperTable(body.slice(node.position!.start.offset, node.position!.end.offset))) tableCount++;
				}
				const label = [getMessage('paperArchiveImagesToDownload', String(urls.length)), getMessage('paperArchiveInlineTables', String(tableCount))];
				if (tableLinks.size) label.push(getMessage('paperArchiveTablesToExpand', String(tableLinks.size)));
				counter.textContent = label.join(' · ');
			} catch { counter.textContent = getMessage('paperArchiveCountUnavailable'); }
			counter.hidden = false;
		};
		editor.addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(update, 120); }, { signal: listeners.signal });
		includeExtended?.addEventListener('change', update, { signal: listeners.signal });
		update();
	}
	candidates = snapshot ? collectPaperAttachments(snapshot.document, snapshot.source) : [];
	if (!candidates.length) return;
	const details = document.createElement('details'); details.id = 'paper-attachments';
	const summary = document.createElement('summary');
	const list = document.createElement('div'); list.className = 'attachment-list';
	for (const [index, candidate] of candidates.entries()) {
		const label = document.createElement('label');
		const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = String(index);
		const text = document.createElement('span'); text.textContent = candidate.label;
		const info = document.createElement('small');
		const url = new URL(candidate.url);
		info.textContent = `${url.pathname.split('.').pop()!.toUpperCase()} | ${url.hostname}`;
		text.append(info); label.append(checkbox, text); list.append(label);
	}
	const update = () => { summary.textContent = getMessage('paperAttachmentsSelection', [String(list.querySelectorAll('input:checked').length), String(candidates.length)]); };
	list.addEventListener('change', update); update(); details.append(summary, list);
	document.querySelector('.clipper-footer')?.prepend(details);
}

export function applyExtendedContentChoice(markdown: string, source: string) {
	const checkbox = document.querySelector<HTMLInputElement>('#paper-extended-content input');
	return extended && checkbox && !checkbox.checked
		? { ...excludeExtendedPaperContent(markdown, source, extended, getMessage('paperExtendedTableSource')), includeTables: false }
		: { markdown, skippedImages: new Set<string>(), includeTables: Boolean(checkbox?.checked && extended?.tables.size) };
}
export function selectedPaperAttachments(): PaperAttachment[] {
	return Array.from(document.querySelectorAll<HTMLInputElement>('#paper-attachments input:checked'))
		.map(input => candidates[Number(input.value)]).filter(Boolean).map(item => ({ ...item }));
}
