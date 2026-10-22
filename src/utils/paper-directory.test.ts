import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { authorizePaperDirectory, PaperDirectoryError, paperDirectoryFailure, paperFolderName, paperIdentity, savePaperDirectory, WritableDirectory } from './paper-directory';
import { ImageArchiveError } from './image-archive';

class Directory {
	kind = 'directory';
	files = new Map<string, string | ArrayBuffer>();
	directories = new Map<string, Directory>();
	permission: PermissionState = 'granted';
	failPaper = false;
	async queryPermission() { return this.permission; }
	async requestPermission() { return this.permission; }
	async *entries() { yield* this.directories.entries(); }
	async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Directory> {
		if (this.files.has(name)) throw new DOMException('File exists', 'TypeMismatchError');
		if (!this.directories.has(name)) {
			if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
			const child = new Directory(); child.failPaper = this.failPaper;
			this.directories.set(name, child);
		}
		return this.directories.get(name)!;
	}
	async getFileHandle(name: string, options?: { create?: boolean }) {
		if (!options?.create && !this.files.has(name)) throw new DOMException('Missing', 'NotFoundError');
		return { getFile: async () => new File([this.files.get(name)!], name), createWritable: async () => {
			let pending: string | ArrayBuffer = '';
			return {
				write: async (value: string | ArrayBuffer) => { pending = value; },
				close: async () => {
					if (this.failPaper && name === 'paper.md') throw new Error('Disk full');
					this.files.set(name, pending);
				},
				abort: async () => {},
			};
		} };
	}
}
const asHandle = (directory: Directory) => directory as unknown as WritableDirectory;
const identity = { doi: '10.1038/s41592-025-02899-6', published: '2025-10-01' };
const input = { markdown: '# Paper\n\nOriginal English.', title: 'Novae', source: 'https://example.org/article', identity };
beforeEach(() => vi.stubGlobal('navigator', { locks: { request: async (_name: string, callback: () => unknown) => callback() } }));
afterEach(() => vi.unstubAllGlobals());

describe('translation directory', () => {
	it('prepares supplementary files before writes and protects an existing translated archive', async () => {
		const parent = new Directory();
		const attachments = [{ url: 'https://example.org/supplement.csv', label: 'Source data' }];
		const fetcher = vi.fn(async () => new Response('x,y\n1,2', { headers: { 'Content-Type': 'text/csv' } })); vi.stubGlobal('fetch', fetcher);
		const { folder } = await savePaperDirectory(asHandle(parent), { ...input, attachments });
		const bundle = parent.directories.get(folder)!;
		expect(new TextDecoder().decode(bundle.directories.get('supplements')!.files.get('attachment-1-supplement.csv') as ArrayBuffer)).toBe('x,y\n1,2');
		expect(bundle.files.has('supplement-report.json')).toBe(true);
		bundle.files.set('paper.zh-CN.md', 'Keep translation'); const before = [...bundle.files];
		await expect(savePaperDirectory(asHandle(parent), { ...input, attachments })).rejects.toMatchObject({ reason: 'duplicate' });
		expect([...bundle.files]).toEqual(before); expect(fetcher).toHaveBeenCalledOnce();
		const empty = new Directory(); fetcher.mockResolvedValue(new Response('Denied', { status: 403 }));
		await expect(savePaperDirectory(asHandle(empty), { ...input, attachments })).rejects.toMatchObject({ reason: 'blocked' });
		expect(empty.directories.size).toBe(0);
	});
	it('distinguishes permission, image, write and unknown failures without leaking raw details', () => {
		expect(paperDirectoryFailure(new DOMException('Private URL', 'SecurityError')).key).toBe('paperDirectoryError_permission');
		expect(paperDirectoryFailure(new ImageArchiveError('download', 2))).toEqual({ key: 'paperDirectoryError_images', detail: '2' });
		expect(paperDirectoryFailure(new PaperDirectoryError('write', 'folder'))).toEqual({ key: 'paperDirectoryError_write', detail: 'folder' });
		expect(paperDirectoryFailure(new Error('Private URL'))).toEqual({ key: 'paperDirectoryError_unexpected', detail: '' });
	});
	it('normalizes names and DOI metadata without inferring an unknown DOI', () => {
		expect(paperFolderName('Novae', identity, 'id')).toBe('2025_Novae__10.1038_s41592-025-02899-6');
		expect(paperFolderName('../../CON:<bad>', identity, 'id')).not.toMatch(/[<>:"/\\|?*]/);
		expect(paperIdentity([{ name: 'citation_doi', content: 'https://doi.org/10.1234/ABC' }], [], '', '')).toEqual({ doi: '10.1234/abc', published: null });
		expect(paperIdentity([], [], 'https://example.org/10.1234/guess')).toEqual({ doi: null, published: null });
		expect(() => paperIdentity([{ name: 'citation_doi', content: '10.1234/a' }], [{ name: 'doi', value: '10.1234/b' }], '')).toThrow('identity');
	});
	it('creates an untranslated bundle with a source fingerprint and independent verification states', async () => {
		const parent = new Directory();
		const { folder } = await savePaperDirectory(asHandle(parent), input);
		const bundle = parent.directories.get(folder)!;
		expect([...bundle.files.keys()]).toEqual(['translation.json', 'checks.json', 'paper.md']);
		expect([...bundle.directories.keys()]).toEqual(['images']);
		expect(new TextDecoder().decode(bundle.files.get('paper.md') as ArrayBuffer)).toBe(input.markdown);
		const metadata = JSON.parse(bundle.files.get('translation.json') as string);
		expect(metadata).toMatchObject({ status: 'not-started', archiveStatus: 'complete', translationFile: 'paper.zh-CN.md', humanReview: 'not-reviewed', acquisition: { completeness: 'not-assessed' } });
		expect(metadata.sourceVersion.value).toMatch(/^[0-9a-f]{64}$/);
		const checks = JSON.parse(new TextDecoder().decode(bundle.files.get('checks.json') as ArrayBuffer));
		expect(checks.artifact.value).toBe(metadata.sourceVersion.value);
		expect(metadata.acquisition).toMatchObject({ checksFile: 'checks.json', completeness: checks.completeness, preservation: checks.preservation, coverage: checks.coverage });
	});
	it('never replaces an existing paper or translation, and refuses a file occupying the folder name', async () => {
		const parent = new Directory();
		const { folder } = await savePaperDirectory(asHandle(parent), input);
		const bundle = parent.directories.get(folder)!;
		bundle.files.set('paper.zh-CN.md', 'Manual translation');
		const before = [...bundle.files];
		await expect(savePaperDirectory(asHandle(parent), { ...input, markdown: 'Changed' })).rejects.toMatchObject({ reason: 'duplicate' });
		expect([...bundle.files]).toEqual(before);
		const other = new Directory(); other.files.set(folder, 'Protected file');
		await expect(savePaperDirectory(asHandle(other), input)).rejects.toMatchObject({ reason: 'exists' });
		expect(other.files.get(folder)).toBe('Protected file');
	});
	it('rejects missing or denied permission before any writes', async () => {
		await expect(authorizePaperDirectory()).rejects.toMatchObject({ reason: 'missing' });
		const parent = new Directory(); parent.permission = 'denied';
		await expect(authorizePaperDirectory(asHandle(parent))).rejects.toMatchObject({ reason: 'permission' });
		await expect(savePaperDirectory(asHandle(parent), input)).rejects.toMatchObject({ reason: 'permission' });
		expect(parent.directories.size).toBe(0);
	});
	it('does not create any files when image preparation fails', async () => {
		const parent = new Directory();
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')));
		await expect(savePaperDirectory(asHandle(parent), { ...input, markdown: '![Figure](https://example.org/a.png)' })).rejects.toMatchObject({ reason: 'download' });
		expect(parent.directories.size).toBe(0);
	});
	it('records a disk failure without claiming completion or deleting partial data', async () => {
		const parent = new Directory(); parent.failPaper = true;
		await expect(savePaperDirectory(asHandle(parent), input)).rejects.toMatchObject({ reason: 'write' });
		const folder = parent.directories.values().next().value!;
		expect(JSON.parse(folder.files.get('translation.json') as string).archiveStatus).toBe('failed');
		expect(folder.files.has('paper.md')).toBe(false);
	});
	it('passes Cell source hints to the downloader and writes the image report beside the note', async () => {
		const small = 'https://www.cell.com/cms/10.1234/test/asset/small/main.assets/gr1.png';
		const large = 'https://www.cell.com/cms/10.1234/test/asset/large/main.assets/gr1_lrg.png';
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
		const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => new Response(png, { headers: { 'Content-Type': 'image/png' } }));
		vi.stubGlobal('fetch', fetcher);
		const parent = new Directory();
		const { folder } = await savePaperDirectory(asHandle(parent), { ...input, source: 'https://www.cell.com/cell/fulltext/test', markdown: `![A](${small})`, imageSources: { [small]: large } });
		const bundle = parent.directories.get(folder)!;
		expect(fetcher.mock.calls[0][0]).toBe(large);
		expect([...bundle.directories.get('images')!.files.keys()]).toEqual(['image-1.png']);
		const report = JSON.parse(new TextDecoder().decode(bundle.files.get('image-report.json') as ArrayBuffer));
		expect(report.items[0].selection).toBe('preferred');
	});
	it('recognizes a DOI after renaming its directory, title or year, without downloading or touching translations', async () => {
		const parent = new Directory();
		const { folder } = await savePaperDirectory(asHandle(parent), input);
		const original = parent.directories.get(folder)!;
		original.files.set('paper.zh-CN.md', 'Translation and annotations');
		const metadata = JSON.parse(original.files.get('translation.json') as string);
		metadata.doi = 'https://doi.org/10.1038/S41592-025-02899-6';
		original.files.set('translation.json', JSON.stringify(metadata));
		parent.directories.delete(folder); parent.directories.set('Renamed archive', original);
		const before = [...original.files];
		const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
		await expect(savePaperDirectory(asHandle(parent), { ...input, title: 'Changed title', identity: { ...identity, published: '2026' }, markdown: '![A](https://example.org/image.png)' })).rejects.toMatchObject({ reason: 'duplicate', folder: 'Renamed archive' });
		expect(fetcher).not.toHaveBeenCalled();
		expect([...original.files]).toEqual(before);
		expect(parent.directories.size).toBe(1);
		const saved = await savePaperDirectory(asHandle(parent), { ...input, title: 'Changed title' }, undefined, { newVersion: true });
		expect(saved.folder).toContain('__v_');
		expect([...original.files]).toEqual(before);
		const version = parent.directories.get(saved.folder)!;
		expect(version.files.has('paper.zh-CN.md')).toBe(false);
		expect(JSON.parse(version.files.get('translation.json') as string).previousArchives).toEqual(['Renamed archive']);
	});
	it('rechecks DOI inside the write lock to catch a concurrent archive', async () => {
		const parent = new Directory();
		vi.stubGlobal('navigator', { locks: { request: async (_name: string, callback: () => unknown) => {
			const other = new Directory();
			other.files.set('translation.json', JSON.stringify({ schemaVersion: 1, sourceFile: 'paper.md', doi: identity.doi, archiveStatus: 'writing' }));
			parent.directories.set('Concurrent archive', other);
			return callback();
		} } });
		await expect(savePaperDirectory(asHandle(parent), input)).rejects.toMatchObject({ reason: 'duplicate', folder: 'Concurrent archive' });
		expect([...parent.directories.keys()]).toEqual(['Concurrent archive']);
	});
	it('does not guess unknown DOI or recurse, and does not silently skip unreadable metadata', async () => {
		const parent = new Directory();
		const nested = new Directory(); parent.directories.set('Unrelated', nested);
		const hidden = new Directory(); nested.directories.set('Nested', hidden);
		hidden.files.set('translation.json', '{invalid');
		await savePaperDirectory(asHandle(parent), input);
		const unknown = { ...input, identity: { doi: null, published: null } };
		await savePaperDirectory(asHandle(parent), unknown);
		await savePaperDirectory(asHandle(parent), unknown);
		expect(parent.directories.size).toBe(4);
		nested.files.set('translation.json', '{invalid');
		await expect(savePaperDirectory(asHandle(parent), input)).rejects.toMatchObject({ reason: 'index', folder: 'Unrelated' });
		expect(parent.directories.size).toBe(4);
	});
});
