import { strToU8 } from 'fflate';

const extensions = new Set(['pdf', 'csv', 'tsv', 'txt', 'xlsx', 'docx', 'zip']);
export interface PaperAttachment { url: string; label: string }
export class AttachmentError extends Error {
	constructor(public readonly reason: 'unsupported' | 'limit' | 'download' | 'blocked', public readonly attachmentNumber = 0) { super(reason); }
}

function attachmentUrl(value: string, source?: string): URL {
	let url: URL;
	try { url = new URL(value, source); } catch { throw new AttachmentError('unsupported'); }
	const host = url.hostname.toLowerCase();
	if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') || host.endsWith('.local') ||
		host.endsWith('.localhost') || host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) throw new AttachmentError('unsupported');
	url.hash = '';
	if (!extensions.has(url.pathname.split('.').pop()!.toLowerCase())) throw new AttachmentError('unsupported');
	return url;
}

// Discovery is local to the captured page. A file suffix alone is not evidence
// that a link is supplementary material rather than the article's main PDF.
export function collectPaperAttachments(document: Document, source: string): PaperAttachment[] {
	const found = new Map<string, PaperAttachment>();
	for (const link of Array.from(document.querySelectorAll('a[href]'))) {
		try {
			const url = attachmentUrl(link.getAttribute('href')!, source);
			const label = (link.textContent ?? '').replace(/\s+/g, ' ').trim();
			const evidence = [label, link.getAttribute('title'), link.getAttribute('aria-label'), url.pathname,
				link.closest('section')?.querySelector('h2,h3')?.textContent].join(' ');
			if (!/supplement(?:ary|al|s)?|supporting[\s_-]+(?:information|data|file)|additional[\s_-]+file|source[\s_-]+data|(?:table|data|document)\s+s\d|(?:moesm|mmc)\d/i.test(evidence)) continue;
			if (!found.has(url.href)) found.set(url.href, { url: url.href, label: label.slice(0, 180) || url.pathname.split('/').pop()!.slice(0, 180) });
			if (found.size >= 50) break;
		} catch { /* No invented URLs or unsupported/local destinations. */ }
	}
	return [...found.values()];
}

function validateFile(bytes: Uint8Array, mime: string, extension: string) {
	const type = mime.split(';')[0].trim().toLowerCase();
	if (!bytes.length || /html|javascript|xml/.test(type) && !/officedocument/.test(type)) throw new AttachmentError('unsupported');
	const opaque = ['', 'application/octet-stream', 'binary/octet-stream'].includes(type);
	const prefix = new TextDecoder().decode(bytes.slice(0, 512)).trimStart();
	if (/^(?:<!doctype\s+html|<html|<head|<body|<script)/i.test(prefix)) throw new AttachmentError('unsupported');
	if (extension === 'pdf') {
		if ((!opaque && type !== 'application/pdf') || !prefix.startsWith('%PDF-')) throw new AttachmentError('unsupported');
	} else if (['xlsx', 'docx', 'zip'].includes(extension)) {
		const mimes: Record<string, string[]> = {
			xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'],
			docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
			zip: ['application/zip', 'application/x-zip-compressed'],
		};
		if ((!opaque && !mimes[extension].includes(type)) || bytes[0] !== 80 || bytes[1] !== 75 ||
			!((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))) throw new AttachmentError('unsupported');
	} else {
		if (!opaque && !['text/plain', 'text/csv', 'text/tab-separated-values', 'application/csv'].includes(type)) throw new AttachmentError('unsupported');
		new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		if (bytes.includes(0)) throw new AttachmentError('unsupported');
	}
}

export async function preparePaperAttachments(selected: PaperAttachment[] = []) {
	if (selected.length > 20) throw new AttachmentError('limit');
	const files: Record<string, Uint8Array> = Object.create(null);
	const destinations = new Map<string, string>();
	const items: { file: string; label: string; bytes: number; sha256: string }[] = [];
	let total = 0;
	for (const [index, item] of selected.entries()) {
		try {
			const url = attachmentUrl(item.url);
			if (destinations.has(url.href)) continue;
			const max = Math.min(50 * 1024 * 1024, 100 * 1024 * 1024 - total);
			if (max <= 0) throw new AttachmentError('limit');
			const response = await fetch(url.href, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30000) });
			if (!response.ok || !response.body) {
				await response.body?.cancel();
				throw new AttachmentError([401, 403].includes(response.status) ? 'blocked' : 'download');
			}
			if (Number(response.headers.get('content-length')) > max) { await response.body.cancel(); throw new AttachmentError('limit'); }
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = []; let size = 0;
			try {
				while (true) {
					const { value, done } = await reader.read(); if (done) break;
					size += value.length; if (size > max) throw new AttachmentError('limit'); chunks.push(value);
				}
			} finally { await reader.cancel(); }
			const bytes = new Uint8Array(size); let offset = 0;
			for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
			const extension = url.pathname.split('.').pop()!.toLowerCase();
			try { validateFile(bytes, response.headers.get('content-type') ?? '', extension); }
			catch { throw new AttachmentError('unsupported'); }
			let basename: string;
			try { basename = decodeURIComponent(url.pathname.split('/').pop()!); } catch { basename = 'supplement'; }
			basename = basename.replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 65) || 'supplement';
			const file = `supplements/attachment-${index + 1}-${basename}.${extension}`;
			files[file] = bytes; destinations.set(url.href, file); total += size;
			const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
			items.push({ file, label: typeof item.label === 'string' ? item.label.slice(0, 180) : '', bytes: size, sha256 });
		} catch (error) { throw new AttachmentError(error instanceof AttachmentError ? error.reason : 'download', index + 1); }
	}
	if (items.length) files['supplement-report.json'] = strToU8(JSON.stringify({ schemaVersion: 1,
		scope: 'explicitly-selected-files-http-type-signature', contentSafety: 'not-assessed', items,
	}, null, 2) + '\n');
	return { files, destinations, count: items.length };
}
