import { prepareImageFiles } from './image-archive';

export interface WritableDirectory extends FileSystemDirectoryHandle {
	queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
	requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
}
type PickerWindow = Window & { showDirectoryPicker?: (options: { id: string; mode: 'readwrite' }) => Promise<WritableDirectory> };
export class PaperDirectoryError extends Error {
	constructor(public readonly reason: 'unsupported' | 'missing' | 'permission' | 'exists' | 'write' | 'identity', public readonly folder = '') { super(reason); }
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

export interface PaperIdentity { doi: string | null; published: string | null }
export function paperIdentity(meta: { name?: string | null; property?: string | null; content: string | null }[],
	properties: { name: string; value: unknown }[], source: string, published?: string): PaperIdentity {
	const normalizeDoi = (value: unknown): string | null => {
		if (typeof value !== 'string') return null;
		let doi = value.trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
		try { doi = decodeURIComponent(doi); } catch { return null; }
		return /^10\.\d{4,9}\/[^\s<>"?#]+$/i.test(doi) ? doi.toLowerCase() : null;
	};
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

const safeComponent = (value: string, length: number) => value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
	.replace(/\s+/g, '_').slice(0, length).replace(/[. _]+$/g, '') || 'paper';
export function paperFolderName(title: string, identity: PaperIdentity, id: string): string {
	const year = identity.published?.match(/^\d{4}/)?.[0] ?? 'unknown';
	return `${year}_${safeComponent(title, 44)}__${identity.doi ? safeComponent(identity.doi, 80) : id}`;
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

export async function savePaperDirectory(parent: WritableDirectory, input: { markdown: string; title: string; source: string; identity: PaperIdentity },
	progress: (done: number, total: number) => void = () => {}): Promise<string> {
	const id = crypto.randomUUID();
	const folder = paperFolderName(input.title, input.identity, id);
	if (await parent.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new PaperDirectoryError('permission');
	if (await exists(parent, folder)) throw new PaperDirectoryError('exists', folder);
	// Images must all succeed before any output directory or file is created.
	const prepared = await prepareImageFiles(input.markdown, input.source, progress);
	const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(prepared.files['paper.md']).buffer);
	const sourceVersion = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
	return navigator.locks.request('paper-clipper-directory-write', async () => {
		if (await exists(parent, folder)) throw new PaperDirectoryError('exists', folder);
		let directory: FileSystemDirectoryHandle | undefined;
		const metadata = {
			schemaVersion: 1, id, doi: input.identity.doi, title: input.title, published: input.identity.published,
			sourceUrl: input.source, sourceFile: 'paper.md', translationFile: 'paper.zh-CN.md',
			sourceVersion: { algorithm: 'sha256', value: sourceVersion }, createdAt: new Date().toISOString(),
			status: 'not-started', model: null, completedSections: [], archiveStatus: 'writing',
			acquisition: { method: 'extension-editor', completeness: 'not-assessed', preservation: 'not-assessed', coverage: 'not-assessed', images: prepared.imageCount },
			translationChecks: 'not-run', humanReview: 'not-reviewed',
		};
		try {
			directory = await parent.getDirectoryHandle(folder, { create: true });
			await writeFile(directory, 'translation.json', JSON.stringify(metadata, null, 2) + '\n');
			const images = await directory.getDirectoryHandle('images', { create: true });
			for (const [name, bytes] of Object.entries(prepared.files)) {
				if (name === 'paper.md') continue;
				await writeFile(images, name.slice('images/'.length), bytes);
			}
			await writeFile(directory, 'paper.md', prepared.files['paper.md']);
			metadata.archiveStatus = 'complete';
			await writeFile(directory, 'translation.json', JSON.stringify(metadata, null, 2) + '\n');
			return folder;
		} catch {
			// Leave recoverable evidence; never delete directories or report a partial write as complete.
			metadata.archiveStatus = 'failed';
			if (directory) await writeFile(directory, 'translation.json', JSON.stringify(metadata, null, 2) + '\n').catch(() => {});
			throw new PaperDirectoryError('write', folder);
		}
	});
}
