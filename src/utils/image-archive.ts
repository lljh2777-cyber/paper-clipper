import { fromMarkdown } from 'mdast-util-from-markdown';
import type { RootContent, Definition } from 'mdast';
import { zip, strToU8 } from 'fflate';

const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
export class ImageArchiveError extends Error {
	constructor(public readonly reason: 'unsupported' | 'limit' | 'download', public readonly imageNumber = 0) { super(reason); }
}

function imageType(bytes: Uint8Array, mime: string): string {
	const head = new TextDecoder('ascii').decode(bytes.slice(0, 32));
	const type = mime.split(';')[0].trim().toLowerCase();
	if (type === 'image/png' && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'png';
	if (type === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
	if (type === 'image/gif' && /^GIF8[79]a/.test(head)) return 'gif';
	if (type === 'image/webp' && head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
	if (type === 'image/avif' && head.slice(4, 8) === 'ftyp' && /avif|avis/.test(head.slice(8))) return 'avif';
	throw new ImageArchiveError('unsupported');
}

function imageUrl(value: string, source: string): string {
	const url = new URL(value, source);
	const host = url.hostname.toLowerCase();
	// No local services, embedded credentials, executable formats or ambient cookies.
	if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
		!host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') ||
		host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) throw new ImageArchiveError('unsupported');
	url.hash = '';
	return url.href;
}

async function download(url: string): Promise<{ bytes: Uint8Array; extension: string }> {
	const response = await fetch(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
	if (!response.ok || !response.body) throw new ImageArchiveError('download');
	if (Number(response.headers.get('content-length')) > MAX_IMAGE) {
		await response.body.cancel();
		throw new ImageArchiveError('limit');
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > MAX_IMAGE) throw new ImageArchiveError('limit');
			chunks.push(value);
		}
	} finally { await reader.cancel(); }
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	return { bytes, extension: imageType(bytes, response.headers.get('content-type') ?? '') };
}

export async function createImageArchive(markdown: string, title: string, source: string,
	onProgress: (done: number, total: number) => void = () => {}): Promise<{ bytes: Uint8Array; fileName: string; imageCount: number }> {
	if (markdown.length > 5 * 1024 * 1024) throw new ImageArchiveError('limit');
	const frontmatter = markdown.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? '';
	const tree = fromMarkdown(markdown.slice(frontmatter.length));
	const nodes: RootContent[] = [];
	const walk = (node: RootContent) => {
		nodes.push(node);
		if ('children' in node) node.children.forEach(child => walk(child as RootContent));
	};
	tree.children.forEach(walk);
	const definitions = new Map<string, Definition>();
	for (const node of nodes) if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
	const images: { start: number; end: number; url: string; alt: string; title?: string | null }[] = [];
	for (const node of nodes) {
		// Fail explicitly instead of promising an offline archive with unhandled embeds.
		if (node.type === 'text' && node.value.includes('![[')) throw new ImageArchiveError('unsupported');
		if (node.type === 'html' && /<(?:img|picture|svg|video|audio|iframe|object|embed)\b|\b(?:src|srcset|style)\s*=/i.test(node.value)) throw new ImageArchiveError('unsupported');
		if (node.type !== 'image' && node.type !== 'imageReference') continue;
		const definition = node.type === 'image' ? node : definitions.get(node.identifier);
		if (!definition || node.position?.start.offset === undefined || node.position.end.offset === undefined) throw new ImageArchiveError('unsupported');
		images.push({ start: frontmatter.length + node.position.start.offset, end: frontmatter.length + node.position.end.offset,
			url: imageUrl(definition.url, source), alt: node.alt ?? '', title: definition.title });
	}
	const urls = [...new Set(images.map(image => image.url))];
	if (urls.length > 200) throw new ImageArchiveError('limit');
	const safeTitle = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 90) || 'paper';
	// A unique enclosing directory prevents attachment collisions between extracted papers.
	const root = `paper-${crypto.randomUUID()}`;
	const files: Record<string, Uint8Array> = Object.create(null);
	const destinations = new Map<string, string>();
	let total = 0;
	onProgress(0, urls.length);
	for (const [index, url] of urls.entries()) {
		try {
			const { bytes, extension } = await download(url);
			total += bytes.length;
			if (total > MAX_TOTAL) throw new ImageArchiveError('limit');
			const destination = `images/image-${index + 1}.${extension}`;
			files[`${root}/${destination}`] = bytes;
			destinations.set(url, destination);
			onProgress(index + 1, urls.length);
		} catch (error) { throw new ImageArchiveError(error instanceof ImageArchiveError ? error.reason : 'download', index + 1); }
	}
	const escape = (text: string) => text.replace(/[\\[\]"]/g, '\\$&').replace(/\r?\n/g, ' ');
	for (const image of images.reverse()) {
		const replacement = `![${escape(image.alt)}](<${destinations.get(image.url)}>${image.title ? ` "${escape(image.title)}"` : ''})`;
		markdown = markdown.slice(0, image.start) + replacement + markdown.slice(image.end);
	}
	files[`${root}/paper.md`] = strToU8(markdown);
	const bytes = await new Promise<Uint8Array>((resolve, reject) => zip(files, { level: 0 }, (error, result) => error ? reject(error) : resolve(result)));
	return { bytes, fileName: `paper-${safeTitle}.zip`, imageCount: urls.length };
}

export function downloadImageArchive(bytes: Uint8Array, fileName: string): void {
	const blob = new Blob([new Uint8Array(bytes).buffer], { type: 'application/zip' });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = fileName;
	document.body.appendChild(anchor);
	try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
}
