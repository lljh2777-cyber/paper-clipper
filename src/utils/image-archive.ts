import { fromMarkdown } from 'mdast-util-from-markdown';
import type { RootContent, Definition } from 'mdast';
import { zip, strToU8 } from 'fflate';
import { normalizeDoi, paperFolderName, paperTranslationMetadata, type PaperIdentity } from './paper-bundle';
import { imageDownloadCandidates } from './image-sources.mjs';
import { preparePaperAttachments, type PaperAttachment } from './paper-attachments';
import { unassessedManualExportChecks, markdownSha256, ManualExportCheckContext, ManualExportChecks } from './manual-export-report';

const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30000;
export const IMAGE_DOWNLOAD_CONCURRENCY = 3;
export const IMAGE_DOWNLOAD_RETRY_DELAYS_MS = [300, 900];
interface ImageRequestFailure { imageNumber: number; url: string; httpStatus?: number }
interface DownloadedImage { bytes: Uint8Array; extension: string; selection: 'preferred' | 'original-fallback' | 'original' }
export interface ImageDownloadSession {
	completed: Map<string, DownloadedImage>;
	retryAt: Map<string, number>;
}
export function createImageDownloadSession(): ImageDownloadSession {
	return { completed: new Map(), retryAt: new Map() };
}

export class ImageArchiveError extends Error {
	constructor(public readonly reason: 'unsupported' | 'limit' | 'download', public readonly imageNumber = 0,
		public readonly requests: readonly ImageRequestFailure[] = []) { super(reason); }
}
class ImageResponseError extends ImageArchiveError {
	constructor(reason: ImageArchiveError['reason'], public readonly status: number, public readonly retryAfter?: string | null) { super(reason); }
}
export function isRetryableImageStatus(status: number): boolean {
	return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function imageType(bytes: Uint8Array, mime: string): string | undefined {
	const head = new TextDecoder('ascii').decode(bytes.slice(0, 32));
	const type = mime.split(';')[0].trim().toLowerCase();
	if (type === 'image/png' && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'png';
	if (type === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
	if (type === 'image/gif' && /^GIF8[79]a/.test(head)) return 'gif';
	if (type === 'image/webp' && head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
	if (type === 'image/avif' && head.slice(4, 8) === 'ftyp' && /avif|avis/.test(head.slice(8))) return 'avif';
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

const plos = 'https://journals.plos.org';
const plosStorage = 'https://corpus-prod.f505aadad1e46610c8f8563037eb3c4b.r2.cloudflarestorage.com';

function plosFigure(url: URL, source: string): string | undefined {
	if (url.origin !== plos) return;
	const page = new URL(source);
	const figure = url.searchParams.get('id') ?? '';
	const match = /^(10\.1371\/journal\.[a-z]+\.\d+)\.g\d+$/.exec(figure);
	if (page.origin === plos && /^\/[a-z]+\/article$/.test(page.pathname) &&
		url.pathname === page.pathname + '/figure/image' && match && page.searchParams.get('id') === match[1] &&
		url.searchParams.getAll('id').length === 1 && url.searchParams.getAll('size').length === 1 &&
		Array.from(url.searchParams.keys()).every(key => ['id', 'size', 'download'].includes(key)) &&
		/^(inline|medium|large)$/.test(url.searchParams.get('size') ?? '')) return figure;
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new ImageArchiveError('download'));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new ImageArchiveError('download'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

async function downloadOnce(url: string, source: string, maxBytes: number, batchSignal?: AbortSignal) {
	const timeout = AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS);
	const signal = batchSignal ? AbortSignal.any([timeout, batchSignal]) : timeout;
	const options: RequestInit = { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal };
	const figure = plosFigure(new URL(url), source);
	if (!figure) return readImage(await fetch(url, options), maxBytes);

	// Fetch hides Location on manual redirects. The frame's CSP checks every
	// network hop before it is sent, including intermediate redirects.
	const frame = document.createElement('iframe');
	frame.hidden = true;
	frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${plos} ${plosStorage}">`;
	try {
		await new Promise<void>((resolve, reject) => {
			const abort = () => reject(new ImageArchiveError('download'));
			frame.onload = () => { signal.removeEventListener('abort', abort); resolve(); };
			signal.addEventListener('abort', abort, { once: true });
			document.body.append(frame);
		});
		const client = frame.contentWindow as (Window & typeof globalThis) | null;
		if (!client) throw new TypeError('Image download frame unavailable');
		let cspBlocked = false;
		client.addEventListener('securitypolicyviolation', () => { cspBlocked = true; });
		let response: Response;
		try {
			response = await client.fetch(url, { ...options, redirect: 'follow', cache: 'no-store' });
		} catch (error) {
			if (cspBlocked) throw new ImageArchiveError('download');
			await new Promise(resolve => setTimeout(resolve, 0));
			if (cspBlocked) throw new ImageArchiveError('download');
			throw error;
		}
		if (response.redirected) {
			const target = new URL(response.url);
			const asset = /^\/(10\.1371\/journal\.[a-z]+\.\d+)\/\d+\/([^/]+)\.PNG_[IML]$/i.exec(target.pathname);
			if (target.origin !== plosStorage || !asset || asset[1] !== figure.replace(/\.g\d+$/, '') ||
				'10.1371/journal.' + asset[2] !== figure) {
				await response.body?.cancel();
				throw new ImageArchiveError('download');
			}
		}
		return await readImage(response, maxBytes);
	} finally { frame.remove(); }
}

function retryAfterDelay(header: string | null | undefined): number | undefined {
	const value = header?.trim();
	if (!value) return;
	if (/^\d+$/.test(value)) {
		const delay = Number(value) * 1000;
		return Number.isSafeInteger(delay) ? delay : undefined;
	}
	if (!/[A-Za-z]/.test(value)) return;
	const date = Date.parse(value);
	if (Number.isFinite(date)) return Math.max(0, date - Date.now());
}

async function download(url: string, source: string, maxBytes: number, batchSignal: AbortSignal, session: ImageDownloadSession) {
	const origin = new URL(url).origin;
	for (let attempt = 0; ; attempt++) {
		// A 429 cooldown applies to every worker and to fallback URLs on this origin.
		let remaining: number;
		while ((remaining = (session.retryAt.get(origin) ?? 0) - Date.now()) > 0) {
			await sleepWithSignal(Math.min(remaining, 2_147_483_647), batchSignal);
		}
		if (batchSignal.aborted) throw new ImageArchiveError('download');
		try {
			return await downloadOnce(url, source, maxBytes, batchSignal);
		} catch (error) {
			const responseError = error instanceof ImageResponseError ? error : undefined;
			const status = responseError?.status;
			const limited = status === 429;
			const backoff = IMAGE_DOWNLOAD_RETRY_DELAYS_MS[Math.min(attempt, IMAGE_DOWNLOAD_RETRY_DELAYS_MS.length - 1)];
			if (limited && !batchSignal.aborted) {
				const delay = retryAfterDelay(responseError?.retryAfter) ?? backoff;
				session.retryAt.set(origin, Math.max(session.retryAt.get(origin) ?? 0, Date.now() + delay));
			}
			const retryable = !(error instanceof ImageArchiveError) || error.reason === 'download' && status !== undefined && isRetryableImageStatus(status);
			if (batchSignal.aborted || !retryable || attempt >= IMAGE_DOWNLOAD_RETRY_DELAYS_MS.length) throw error;
			if (!limited) await sleepWithSignal(backoff, batchSignal);
		}
	}
}

async function readImage(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; extension: string }> {
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw new ImageResponseError('download', response.status, response.headers.get('Retry-After'));
	}
	if (Number(response.headers.get('content-length')) > maxBytes) {
		await response.body.cancel();
		throw new ImageResponseError('limit', response.status);
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > maxBytes) throw new ImageResponseError('limit', response.status);
			chunks.push(value);
		}
	} finally { await reader.cancel(); }
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	const extension = imageType(bytes, response.headers.get('content-type') ?? '');
	if (!extension) throw new ImageResponseError('unsupported', response.status);
	return { bytes, extension };
}

export function inspectArchiveMarkdown(markdown: string, source: string) {
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
	return { frontmatter, tree, nodes, definitions, images, urls };
}

export async function prepareImageFiles(markdown: string, source: string,
	onProgress: (done: number, total: number) => void = () => {}, imageSources: Record<string, string> = {},
	checkContext?: ManualExportCheckContext, figureLinks: Record<string, string> = {}, attachments: PaperAttachment[] = [], bibtex?: string,
	session = createImageDownloadSession()): Promise<{ files: Record<string, Uint8Array>; imageCount: number; checks: ManualExportChecks }> {
	const { frontmatter, nodes, definitions, images, urls } = inspectArchiveMarkdown(markdown, source);
	const checks = checkContext?.inputSha256 === await markdownSha256(markdown) ? checkContext.report : unassessedManualExportChecks();
	const files: Record<string, Uint8Array> = Object.create(null);
	const destinations = new Map<string, string>();
	const selections: { file: string; selection: DownloadedImage['selection'] }[] = [];
	const pending = urls.map((url, index) => ({ url, index })).filter(({ url }) => !session.completed.has(url));
	let completed = urls.length - pending.length;
	let total = urls.reduce((bytes, url) => bytes + (session.completed.get(url)?.bytes.length ?? 0), 0);
	onProgress(completed, urls.length);
	if (urls.length > 0) {
		const controller = new AbortController();
		let next = 0;
		const errors: ImageArchiveError[] = [];

		async function worker() {
			while (true) {
				if (controller.signal.aborted) return;
				const item = pending[next++];
				if (!item) return;
				const { index, url } = item;
				const imageNumber = index + 1;
				try {
					const remaining = MAX_TOTAL - total;
					if (remaining <= 0) throw new ImageArchiveError('limit', imageNumber);
					const candidates = imageDownloadCandidates(url, source, imageSources);
					const requests: ImageRequestFailure[] = [];
					let result: Awaited<ReturnType<typeof download>> | undefined;
					let selected = 0;
					for (const [candidateIndex, candidate] of candidates.entries()) {
						if (controller.signal.aborted) return;
						try {
							result = await download(imageUrl(candidate, source), source, Math.min(MAX_IMAGE, remaining), controller.signal, session);
							selected = candidateIndex;
							break;
						} catch (error) {
							if (controller.signal.aborted) return;
							requests.push({ imageNumber, url: candidate, httpStatus: error instanceof ImageResponseError ? error.status : undefined });
							if (candidateIndex === candidates.length - 1) throw new ImageArchiveError(error instanceof ImageArchiveError ? error.reason : 'download', imageNumber, requests);
						}
					}
					if (controller.signal.aborted) return;
					const { bytes, extension } = result!;
					if (total + bytes.length > MAX_TOTAL) throw new ImageArchiveError('limit', imageNumber);
					total += bytes.length;
					session.completed.set(url, {
						bytes,
						extension,
						selection: candidates.length === 1 ? 'original' : selected === 0 ? 'preferred' : 'original-fallback',
					});
					completed++;
					onProgress(completed, urls.length);
				} catch (error) {
					if (controller.signal.aborted) return;
					const failure = error instanceof ImageArchiveError ? error : new ImageArchiveError('download', imageNumber);
					errors.push(failure);
					if (failure.reason !== 'download') controller.abort();
				}
			}
		}

		await Promise.all(Array.from({ length: Math.min(IMAGE_DOWNLOAD_CONCURRENCY, pending.length) }, () => worker()));
		if (errors.length) {
			errors.sort((a, b) => a.imageNumber - b.imageNumber);
			const first = errors.find(error => error.reason !== 'download') ?? errors[0];
			throw new ImageArchiveError(first.reason, first.imageNumber, errors.flatMap(error => error.requests));
		}
		for (const [index, url] of urls.entries()) {
			const item = session.completed.get(url)!;
			const destination = `images/image-${index + 1}.${item.extension}`;
			files[destination] = item.bytes;
			destinations.set(url, destination);
			selections.push({ file: destination, selection: item.selection });
		}
	}
	const supplements = await preparePaperAttachments(attachments);
	Object.assign(files, supplements.files);
	for (const [url, destination] of supplements.destinations) destinations.set(url, destination);
	const escape = (text: string) => text.replace(/[\\[\]"]/g, '\\$&').replace(/\r?\n/g, ' ');
	const edits: { start: number; end: number; replacement: string }[] = [];
	for (const image of images) {
		const replacement = `![${escape(image.alt)}](<${destinations.get(image.url)}>${image.title ? ` "${escape(image.title)}"` : ''})`;
		edits.push({ start: image.start, end: image.end, replacement });
	}
	for (const node of nodes) {
		if (node.type !== 'link' && node.type !== 'linkReference') continue;
		const definition = node.type === 'link' ? node : definitions.get(node.identifier);
		if (!definition || !node.children.length || node.position?.start.offset === undefined || node.position.end.offset === undefined) continue;
		const start = frontmatter.length + node.position.start.offset, end = frontmatter.length + node.position.end.offset;
		if (images.some(image => image.start >= start && image.end <= end)) continue;
		let destination: string | undefined;
		try {
			const url = new URL(definition.url, source).href;
			const target = Object.prototype.hasOwnProperty.call(figureLinks, url) ? figureLinks[url] : url;
			destination = destinations.get(imageUrl(target, source));
		} catch { continue; }
		if (!destination) continue;
		const first = node.children[0].position?.start.offset, last = node.children[node.children.length - 1].position?.end.offset;
		if (first === undefined || last === undefined) continue;
		const label = markdown.slice(frontmatter.length + first, frontmatter.length + last);
		edits.push({ start, end, replacement: `[${label}](<${destination}>${definition.title ? ` "${escape(definition.title)}"` : ''})` });
	}
	for (const edit of edits.sort((a, b) => b.start - a.start)) {
		markdown = markdown.slice(0, edit.start) + edit.replacement + markdown.slice(edit.end);
	}
	files['paper.md'] = strToU8(markdown);
	const finalChecks: ManualExportChecks = { ...checks,
		...(supplements.count ? { attachments: { selected: supplements.count, downloaded: supplements.count, scope: 'http-type-signature', contentSafety: 'not-assessed' as const } } : {}),
		images: { status: 'passed', scope: 'referenced-images-http-mime-signature', downloaded: urls.length,
			originalFallbacks: selections.filter(item => item.selection === 'original-fallback').length },
	};
	files['checks.json'] = strToU8(JSON.stringify({ ...finalChecks,
		artifact: { file: 'paper.md', algorithm: 'sha256', value: await markdownSha256(markdown) },
	}, null, 2) + '\n');
	if (selections.some(item => item.selection !== 'original')) files['image-report.json'] = strToU8(JSON.stringify({
		schemaVersion: 1, policy: 'prefer-publisher-high-resolution', items: selections,
	}, null, 2) + '\n');
	if (bibtex?.trim()) {
		files['citation.bib'] = strToU8(bibtex.endsWith('\n') ? bibtex : bibtex + '\n');
	}
	return { files, imageCount: urls.length, checks: finalChecks };
}

export async function createImageArchive(markdown: string, title: string, source: string,
	onProgress: (done: number, total: number) => void = () => {}, imageSources: Record<string, string> = {},
	checkContext?: ManualExportCheckContext, identity: PaperIdentity = { doi: null, published: null }, figureLinks: Record<string, string> = {}, attachments: PaperAttachment[] = [], bibtex?: string,
	session?: ImageDownloadSession): Promise<{ bytes: Uint8Array; fileName: string; imageCount: number; checks: ManualExportChecks }> {
	const doi = normalizeDoi(identity.doi);
	if (identity.doi && !doi) throw new Error('Invalid paper DOI');
	identity = { ...identity, doi };
	const prepared = await prepareImageFiles(markdown, source, onProgress, imageSources, checkContext, figureLinks, attachments, bibtex, session);
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
