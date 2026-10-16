import { ImageArchiveError, prepareImageFiles } from './image-archive';
import type { ManualExportCheckContext } from './manual-export-report';
import { normalizeDoi, paperFolderName, paperTranslationMetadata, type PaperIdentity } from './paper-bundle';
export { paperFolderName, type PaperIdentity } from './paper-bundle';

export interface WritableDirectory extends FileSystemDirectoryHandle {
	entries(): AsyncIterableIterator<[string, FileSystemFileHandle | WritableDirectory]>;
	queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
	requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
}
type PickerWindow = Window & { showDirectoryPicker?: (options: { id: string; mode: 'readwrite' }) => Promise<WritableDirectory> };
export class PaperDirectoryError extends Error {
	constructor(public readonly reason: 'unsupported' | 'missing' | 'permission' | 'exists' | 'duplicate' | 'index' | 'write' | 'identity' | 'handoff' | 'busy' | 'expired', public readonly folder = '') { super(reason); }
}

export function paperDirectoryFailure(error: unknown): { key: string; detail: string } {
	if (error instanceof ImageArchiveError) return { key: 'paperDirectoryError_images', detail: String(error.imageNumber) };
	if (error instanceof PaperDirectoryError) return { key: `paperDirectoryError_${error.reason}`, detail: error.folder };
	if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) {
		return { key: 'paperDirectoryError_permission', detail: '' };
	}
	return { key: 'paperDirectoryError_unexpected', detail: '' };
}

// Directory handles are structured-cloned locally, never synced or exported with settings.
async function directoryStore(mode: 'read' | 'write' | 'forget', handle?: WritableDirectory): Promise<WritableDirectory | undefined> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open('paper-clipper-directory', 1);
		request.onupgradeneeded = () => request.result.createObjectStore('settings');
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	try {
		return await new Promise((resolve, reject) => {
			const transaction = db.transaction('settings', mode === 'read' ? 'readonly' : 'readwrite');
			const store = transaction.objectStore('settings');
			const request = mode === 'read' ? store.get('directory') : mode === 'forget' ? store.delete('directory') : store.put(handle, 'directory');
			transaction.oncomplete = () => resolve(mode === 'read' ? request.result : handle);
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
	} finally { db.close(); }
}
export const getPaperDirectory = () => directoryStore('read');
export const forgetPaperDirectory = () => directoryStore('forget');
export const supportsPaperDirectory = () => typeof (window as PickerWindow).showDirectoryPicker === 'function';

export async function choosePaperDirectory(): Promise<WritableDirectory> {
	const picker = (window as PickerWindow).showDirectoryPicker;
	if (!picker) throw new PaperDirectoryError('unsupported');
	const handle = await picker.call(window, { id: 'paper-clipper', mode: 'readwrite' });
	await directoryStore('write', handle);
	return handle;
}
export async function authorizePaperDirectory(handle?: WritableDirectory): Promise<WritableDirectory> {
	if (!handle) throw new PaperDirectoryError('missing');
	if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted' &&
		await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new PaperDirectoryError('permission');
	return handle;
}

export interface PaperDirectoryInput { markdown: string; title: string; source: string; identity: PaperIdentity; imageSources?: Record<string, string>; checkContext?: ManualExportCheckContext; figureLinks?: Record<string, string> }

export function paperIdentity(meta: { name?: string | null; property?: string | null; content: string | null }[],
	properties: { name: string; value: unknown }[], source: string, published?: string): PaperIdentity {
	const candidates = meta.filter(tag => ['citation_doi', 'dc.identifier', 'dc.identifier.doi', 'prism.doi'].includes((tag.name ?? tag.property ?? '').toLowerCase())).map(tag => tag.content);
	candidates.push(...properties.filter(property => property.name.toLowerCase() === 'doi').map(property => typeof property.value === 'string' ? property.value : null));
	try {
		const url = new URL(source);
		if (['doi.org', 'dx.doi.org'].includes(url.hostname)) candidates.push(url.origin + url.pathname);
	} catch { /* A missing source URL does not justify inferring a DOI. */ }
	const dois = [...new Set(candidates.map(normalizeDoi).filter((value): value is string => !!value))];
	if (dois.length > 1) throw new PaperDirectoryError('identity');
	const date = meta.find(tag => tag.name?.toLowerCase() === 'citation_publication_date')?.content ??
		properties.find(property => property.name.toLowerCase() === 'published')?.value ?? published;
	return { doi: dois[0] ?? null, published: typeof date === 'string' && /^\d{4}(?:$|[-/T\s])/.test(date.trim()) ? date.trim() : null };
}

async function exists(parent: FileSystemDirectoryHandle, name: string): Promise<boolean> {
	try { await parent.getDirectoryHandle(name); return true; }
	catch (error) {
		if (error instanceof DOMException && error.name === 'NotFoundError') return false;
		if (error instanceof DOMException && error.name === 'TypeMismatchError') return true;
		throw error;
	}
}
async function writeFile(directory: FileSystemDirectoryHandle, name: string, contents: string | Uint8Array): Promise<void> {
	const file = await directory.getFileHandle(name, { create: true });
	const writer = await file.createWritable();
	try {
		await writer.write(typeof contents === 'string' ? contents : new Uint8Array(contents).buffer);
		await writer.close();
	} catch (error) { await writer.abort().catch(() => {}); throw error; }
}

// Only immediate archive metadata is inspected. Never read notes/translations or
// trust an index cached before another tab or tool created an archive.
async function matchingArchives(parent: WritableDirectory, doi: string | null): Promise<string[]> {
	if (!doi) return [];
	const matches: string[] = [];
	for await (const [name, entry] of parent.entries()) {
		if (entry.kind !== 'directory') continue;
		let file: File;
		try { file = await (await entry.getFileHandle('translation.json')).getFile(); }
		catch (error) {
			if (error instanceof DOMException && error.name === 'NotFoundError') continue;
			throw new PaperDirectoryError('index', name);
		}
		try {
			if (file.size > 128 * 1024) throw new Error('Metadata too large');
			const metadata = JSON.parse(await file.text());
			if (metadata?.schemaVersion === 1 && metadata.sourceFile === 'paper.md' && normalizeDoi(metadata.doi) === doi) matches.push(name);
		} catch { throw new PaperDirectoryError('index', name); }
	}
	return matches.sort();
}

export async function savePaperDirectory(parent: WritableDirectory, input: PaperDirectoryInput,
	progress: (done: number, total: number) => void = () => {}, options: { newVersion?: boolean } = {}) {
	const id = crypto.randomUUID();
	const doi = normalizeDoi(input.identity.doi);
	if (input.identity.doi && !doi) throw new PaperDirectoryError('identity');
	const folder = paperFolderName(input.title, { ...input.identity, doi }, id) + (options.newVersion ? `__v_${id}` : '');
	if (await parent.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new PaperDirectoryError('permission');
	const duplicates = await matchingArchives(parent, doi);
	if (duplicates.length && !options.newVersion) throw new PaperDirectoryError('duplicate', duplicates.join('\n'));
	if (await exists(parent, folder)) throw new PaperDirectoryError('exists', folder);
	// Images must all succeed before any output directory or file is created.
	const prepared = await prepareImageFiles(input.markdown, input.source, progress, input.imageSources, input.checkContext, input.figureLinks);
	const baseMetadata = await paperTranslationMetadata({ ...input, identity: { ...input.identity, doi } }, prepared, id);
	return navigator.locks.request('paper-clipper-directory-write', async () => {
		const previousArchives = await matchingArchives(parent, doi);
		if (previousArchives.length && !options.newVersion) throw new PaperDirectoryError('duplicate', previousArchives.join('\n'));
		if (await exists(parent, folder)) throw new PaperDirectoryError('exists', folder);
		let directory: FileSystemDirectoryHandle | undefined;
		const metadata = {
			...baseMetadata,
			...(options.newVersion ? { previousArchives } : {}),
		};
		try {
			directory = await parent.getDirectoryHandle(folder, { create: true });
			await writeFile(directory, 'translation.json', JSON.stringify(metadata, null, 2) + '\n');
			const images = await directory.getDirectoryHandle('images', { create: true });
			for (const [name, bytes] of Object.entries(prepared.files)) {
				if (name === 'paper.md') continue;
				if (name === 'image-report.json' || name === 'checks.json') await writeFile(directory, name, bytes);
				else await writeFile(images, name.slice('images/'.length), bytes);
			}
			await writeFile(directory, 'paper.md', prepared.files['paper.md']);
			metadata.archiveStatus = 'complete';
			await writeFile(directory, 'translation.json', JSON.stringify(metadata, null, 2) + '\n');
			return { folder, checks: prepared.checks };
		} catch {
			// Leave recoverable evidence; never delete directories or report a partial write as complete.
			metadata.archiveStatus = 'failed';
			if (directory) await writeFile(directory, 'translation.json', JSON.stringify(metadata, null, 2) + '\n').catch(() => {});
			throw new PaperDirectoryError('write', folder);
		}
	});
}
