import { fromMarkdown } from 'mdast-util-from-markdown';
import type { RootContent, Definition } from 'mdast';
import { zip, strToU8 } from 'fflate';
import { normalizeDoi, paperFolderName, paperTranslationMetadata, type PaperIdentity } from './paper-bundle';
import { imageDownloadCandidates } from './image-sources.mjs';
import { unassessedManualExportChecks, markdownSha256, ManualExportCheckContext, ManualExportChecks } from './manual-export-report';

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

async function download(url: string, maxBytes = MAX_IMAGE): Promise<{ bytes: Uint8Array; extension: string }> {
	const response = await fetch(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw new ImageArchiveError('download');
	}
	if (Number(response.headers.get('content-length')) > maxBytes) {
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
			if (size > maxBytes) throw new ImageArchiveError('limit');
			chunks.push(value);
		}
	} finally { await reader.cancel(); }
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	return { bytes, extension: imageType(bytes, response.headers.get('content-type') ?? '') };
}

export async function prepareImageFiles(markdown: string, source: string,
	onProgress: (done: number, total: number) => void = () => {}, imageSources: Record<string, string> = {},
	checkContext?: ManualExportCheckContext): Promise<{ files: Record<string, Uint8Array>; imageCount: number; checks: ManualExportChecks }> {
	if (markdown.length > 5 * 1024 * 1024) throw new ImageArchiveError('limit');
	const checks = checkContext?.inputSha256 === await markdownSha256(markdown) ? checkContext.report : unassessedManualExportChecks();
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
	const files: Record<string, Uint8Array> = Object.create(null);
	const destinations = new Map<string, string>();
	const selections: { file: string; selection: 'preferred' | 'original-fallback' | 'original' }[] = [];
	let total = 0;
	onProgress(0, urls.length);
	for (const [index, url] of urls.entries()) {
		try {
			if (total >= MAX_TOTAL) throw new ImageArchiveError('limit');
			const candidates = imageDownloadCandidates(url, source, imageSources);
			let result: Awaited<ReturnType<typeof download>> | undefined;
			let selected = 0;
			for (const [candidateIndex, candidate] of candidates.entries()) {
				try { result = await download(imageUrl(candidate, source), Math.min(MAX_IMAGE, MAX_TOTAL - total)); selected = candidateIndex; break; }
				catch (error) { if (candidateIndex === candidates.length - 1) throw error; }
			}
			const { bytes, extension } = result!;
			total += bytes.length;
			if (total > MAX_TOTAL) throw new ImageArchiveError('limit');
			const destination = `images/image-${index + 1}.${extension}`;
			files[destination] = bytes;
			destinations.set(url, destination);
			selections.push({ file: destination, selection: candidates.length === 1 ? 'original' : selected === 0 ? 'preferred' : 'original-fallback' });
			onProgress(index + 1, urls.length);
		} catch (error) { throw new ImageArchiveError(error instanceof ImageArchiveError ? error.reason : 'download', index + 1); }
	}
	const escape = (text: string) => text.replace(/[\\[\]"]/g, '\\$&').replace(/\r?\n/g, ' ');
	for (const image of images.reverse()) {
		const replacement = `![${escape(image.alt)}](<${destinations.get(image.url)}>${image.title ? ` "${escape(image.title)}"` : ''})`;
		markdown = markdown.slice(0, image.start) + replacement + markdown.slice(image.end);
	}
	files['paper.md'] = strToU8(markdown);
	const finalChecks: ManualExportChecks = { ...checks,
		images: { status: 'passed', scope: 'referenced-images-http-mime-signature', downloaded: urls.length,
			originalFallbacks: selections.filter(item => item.selection === 'original-fallback').length },
	};
	files['checks.json'] = strToU8(JSON.stringify({ ...finalChecks,
		artifact: { file: 'paper.md', algorithm: 'sha256', value: await markdownSha256(markdown) },
	}, null, 2) + '\n');
	if (selections.some(item => item.selection !== 'original')) files['image-report.json'] = strToU8(JSON.stringify({
		schemaVersion: 1, policy: 'prefer-publisher-high-resolution', items: selections,
	}, null, 2) + '\n');
	return { files, imageCount: urls.length, checks: finalChecks };
}

export async function createImageArchive(markdown: string, title: string, source: string,
	onProgress: (done: number, total: number) => void = () => {}, imageSources: Record<string, string> = {},
	checkContext?: ManualExportCheckContext, identity: PaperIdentity = { doi: null, published: null }): Promise<{ bytes: Uint8Array; fileName: string; imageCount: number; checks: ManualExportChecks }> {
	const doi = normalizeDoi(identity.doi);
	if (identity.doi && !doi) throw new Error('Invalid paper DOI');
	identity = { ...identity, doi };
	const prepared = await prepareImageFiles(markdown, source, onProgress, imageSources, checkContext);
	const id = crypto.randomUUID();
	const root = paperFolderName(title, identity, id);
	const metadata = await paperTranslationMetadata({ title, source, identity }, prepared, id);
	metadata.archiveStatus = 'complete';
	prepared.files['translation.json'] = strToU8(JSON.stringify(metadata, null, 2) + '\n');
	prepared.files['images/'] = new Uint8Array();
	const files = Object.fromEntries(Object.entries(prepared.files).map(([name, bytes]) => [`${root}/${name}`, bytes]));
	const bytes = await new Promise<Uint8Array>((resolve, reject) => zip(files, { level: 0 }, (error, result) => error ? reject(error) : resolve(result)));
	return { bytes, fileName: `${root}.zip`, imageCount: prepared.imageCount, checks: prepared.checks };
}
