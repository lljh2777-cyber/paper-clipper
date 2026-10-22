import { collectPaperAttachments, type PaperAttachment } from './paper-attachments';
import { getMessage } from './i18n';

let candidates: PaperAttachment[] = [];
export function resetAttachmentPicker(snapshot?: { document: Document; source: string }) {
	document.getElementById('paper-attachments')?.remove();
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
export function selectedPaperAttachments(): PaperAttachment[] {
	return Array.from(document.querySelectorAll<HTMLInputElement>('#paper-attachments input:checked'))
		.map(input => candidates[Number(input.value)]).filter(Boolean).map(item => ({ ...item }));
}
