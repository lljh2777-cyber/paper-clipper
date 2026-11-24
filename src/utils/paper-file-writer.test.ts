import { expect, it, vi } from 'vitest';
import { saveNewPaperFile } from './paper-file-writer';

it('preserves existing files and directories when repeat saves request the same name', async () => {
	const entries = new Map<string, string | null>([['paper.md', 'original'], ['paper (2).md', null]]);
	const directory = {
		getDirectoryHandle: async (name: string) => {
			if (!entries.has(name)) throw new DOMException('', 'NotFoundError');
			if (entries.get(name) !== null) throw new DOMException('', 'TypeMismatchError');
		},
		getFileHandle: async (name: string) => ({ createWritable: async () => ({
			write: async (content: string) => entries.set(name, content), close: async () => {},
		}) }),
	} as unknown as FileSystemDirectoryHandle;
	const queue = { next: Promise.resolve<unknown>(undefined) };
	vi.stubGlobal('navigator', { locks: { request: (_: string, write: () => Promise<string>) => (queue.next = queue.next.then(write)) } });
	try {
		expect(await Promise.all(['first', 'second'].map(body => saveNewPaperFile(directory, 'paper.md', body))))
			.toEqual(['paper (3).md', 'paper (4).md']);
		expect([...entries.values()]).toEqual(['original', null, 'first', 'second']);
	} finally { vi.unstubAllGlobals(); }
});
