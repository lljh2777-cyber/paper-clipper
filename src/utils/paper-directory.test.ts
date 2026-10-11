import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { authorizePaperDirectory, PaperDirectoryError, paperDirectoryFailure, paperFolderName, paperIdentity, savePaperDirectory, WritableDirectory } from './paper-directory';
import { ImageArchiveError } from './image-archive';

class Directory {
	files = new Map<string, string | ArrayBuffer>();
	directories = new Map<string, Directory>();
	permission: PermissionState = 'granted';
	failPaper = false;
	async queryPermission() { return this.permission; }
	async requestPermission() { return this.permission; }
	async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Directory> {
		if (this.files.has(name)) throw new DOMException('File exists', 'TypeMismatchError');
		if (!this.directories.has(name)) {
			if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
			const child = new Directory(); child.failPaper = this.failPaper;
			this.directories.set(name, child);
		}
		return this.directories.get(name)!;
	}
	async getFileHandle(name: string) {
		return { createWritable: async () => {
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
		const folder = await savePaperDirectory(asHandle(parent), input);
		const bundle = parent.directories.get(folder)!;
		expect([...bundle.files.keys()]).toEqual(['translation.json', 'paper.md']);
		expect([...bundle.directories.keys()]).toEqual(['images']);
		expect(new TextDecoder().decode(bundle.files.get('paper.md') as ArrayBuffer)).toBe(input.markdown);
		const metadata = JSON.parse(bundle.files.get('translation.json') as string);
		expect(metadata).toMatchObject({ status: 'not-started', archiveStatus: 'complete', translationFile: 'paper.zh-CN.md', humanReview: 'not-reviewed', acquisition: { completeness: 'not-assessed' } });
		expect(metadata.sourceVersion.value).toMatch(/^[0-9a-f]{64}$/);
	});
	it('never replaces an existing paper or translation, and refuses a file occupying the folder name', async () => {
		const parent = new Directory();
		const folder = await savePaperDirectory(asHandle(parent), input);
		const bundle = parent.directories.get(folder)!;
		bundle.files.set('paper.zh-CN.md', 'Manual translation');
		const before = [...bundle.files];
		await expect(savePaperDirectory(asHandle(parent), { ...input, markdown: 'Changed' })).rejects.toMatchObject({ reason: 'exists' });
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
});
