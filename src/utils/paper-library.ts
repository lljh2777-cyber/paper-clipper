import { normalizeDoi } from './paper-bundle';

export interface ReadableDirectory extends FileSystemDirectoryHandle {
	entries(): AsyncIterableIterator<[string, FileSystemFileHandle | ReadableDirectory]>;
	queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
	requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
}
export interface ArchiveEntry {
	folder: string; title: string; doi: string | null; year: string; createdAt: string;
	archiveStatus: 'complete' | 'writing' | 'failed' | 'unknown';
	translationStatus: string;
}
export interface ArchiveCatalog {
	entries: ArchiveEntry[]; issues: { folder: string; reason: 'invalid' | 'unreadable' | 'unsupported' }[];
	skipped: number; truncated: boolean;
}

const text = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : '';
export async function readArchiveCatalog(directory: ReadableDirectory): Promise<ArchiveCatalog> {
	if (await directory.queryPermission({ mode: 'read' }) !== 'granted') throw new DOMException('Read permission required', 'NotAllowedError');
	const result: ArchiveCatalog = { entries: [], issues: [], skipped: 0, truncated: false };
	let visited = 0;
	for await (const [folder, entry] of directory.entries()) {
		if (++visited > 5000) { result.truncated = true; break; }
		if (entry.kind !== 'directory') continue;
		let file: File;
		try { file = await (await entry.getFileHandle('translation.json')).getFile(); }
		catch (error) {
			if (error instanceof DOMException && error.name === 'NotAllowedError') throw error;
			if (error instanceof DOMException && error.name === 'NotFoundError') result.skipped++;
			else result.issues.push({ folder, reason: 'unreadable' });
			continue;
		}
		try {
			if (file.size > 128 * 1024) throw new Error('Metadata too large');
			const metadata = JSON.parse(await file.text());
			if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid metadata');
			if (metadata.schemaVersion !== 1 || metadata.sourceFile !== 'paper.md') {
				result.issues.push({ folder, reason: 'unsupported' }); continue;
			}
			const doi = normalizeDoi(metadata.doi);
			if (metadata.doi != null && metadata.doi !== '' && !doi) throw new Error('Invalid DOI');
			const created = text(metadata.createdAt, 64);
			result.entries.push({ folder, title: text(metadata.title, 2000).trim() || folder, doi,
				year: text(metadata.published, 64).match(/^\d{4}(?:$|[-/T\s])/)?.[0].slice(0, 4) ?? '',
				createdAt: Number.isFinite(Date.parse(created)) ? new Date(created).toISOString() : '',
				archiveStatus: ['complete', 'writing', 'failed'].includes(metadata.archiveStatus) ? metadata.archiveStatus : 'unknown',
				translationStatus: text(metadata.status, 80) || 'unknown',
			});
		} catch (error) {
			if (error instanceof DOMException && error.name === 'NotAllowedError') throw error;
			result.issues.push({ folder, reason: 'invalid' });
		}
	}
	return result;
}

export function searchArchives(entries: ArchiveEntry[], query: string, sort: 'newest' | 'title' | 'year'): ArchiveEntry[] {
	const normalized = normalizeDoi(query) ?? query.trim().toLowerCase();
	const terms = normalized.split(/\s+/).filter(Boolean);
	return entries.filter(entry => {
		const content = [entry.title, entry.doi ?? '', entry.year, entry.folder].join('\n').toLowerCase();
		return terms.every(term => content.includes(term));
	}).sort((a, b) => (sort === 'title' ? a.title.localeCompare(b.title) : sort === 'year' ? b.year.localeCompare(a.year) : b.createdAt.localeCompare(a.createdAt)) || a.folder.localeCompare(b.folder));
}
