import { expect, it, vi } from 'vitest';
import { readArchiveCatalog, searchArchives, type ReadableDirectory } from './paper-library';

function fixture(files: Record<string, unknown>) {
	const read = vi.fn();
	const entries = vi.fn(async function* () {
		for (const [name, value] of Object.entries(files)) {
			yield [name, { kind: 'directory', getFileHandle: async (...args: unknown[]) => {
				read(...args);
				if (value instanceof Error) throw value;
				return { getFile: async () => ({ size: typeof value === 'number' ? value : 100,
					text: async () => typeof value === 'string' ? value : JSON.stringify(value) }) };
			} }] as unknown as [string, ReadableDirectory];
		}
	});
	const directory = { queryPermission: vi.fn().mockResolvedValue('granted'), entries } as unknown as ReadableDirectory;
	return { directory, read, entries };
}
const metadata = { schemaVersion: 1, sourceFile: 'paper.md', title: 'Novae paper', doi: 'https://doi.org/10.1234/EXAMPLE',
	published: '2025-01-02', createdAt: '2026-10-22T01:00:00Z', archiveStatus: 'complete', status: 'not-started' };

it('reads only immediate translation.json metadata without create flags, notes or translations', async () => {
	const { directory, read } = fixture({ renamed: metadata, old: { ...metadata, title: 'Earlier paper', published: '2024', createdAt: '2025-01-01', archiveStatus: 'failed' } });
	const result = await readArchiveCatalog(directory);
	expect(directory.queryPermission).toHaveBeenCalledWith({ mode: 'read' });
	expect(read.mock.calls).toEqual([['translation.json'], ['translation.json']]);
	expect(result.entries[0]).toMatchObject({ folder: 'renamed', doi: '10.1234/example', year: '2025', archiveStatus: 'complete', translationStatus: 'not-started' });
	expect(searchArchives(result.entries, 'https://doi.org/10.1234/EXAMPLE', 'newest')).toHaveLength(2);
	expect(searchArchives(result.entries, 'NOVAE 2025', 'title').map(e => e.folder)).toEqual(['renamed']);
	expect(searchArchives(result.entries, 'renamed', 'year')).toHaveLength(1);
	expect(searchArchives(result.entries, '', 'title').map(e => e.folder)).toEqual(['old', 'renamed']);
	expect(searchArchives(result.entries, '', 'year').map(e => e.folder)).toEqual(['renamed', 'old']);
});

it('skips missing metadata and reports invalid, oversized, unreadable and unsupported records without discarding good entries', async () => {
	const { directory } = fixture({ valid: metadata, missing: new DOMException('', 'NotFoundError'), broken: '{', huge: 131073,
		unreadable: new Error('disk'), future: { ...metadata, schemaVersion: 2 }, invalidDoi: { ...metadata, doi: 'oops' } });
	const result = await readArchiveCatalog(directory);
	expect(result.entries).toHaveLength(1); expect(result.skipped).toBe(1);
	expect(result.issues.map(issue => issue.reason)).toEqual(['invalid', 'invalid', 'unreadable', 'unsupported', 'invalid']);
});

it('does not infer missing identities, dates or completion from folder names', async () => {
	const { directory } = fixture({ '2026_fake': { schemaVersion: 1, sourceFile: 'paper.md' } });
	expect((await readArchiveCatalog(directory)).entries[0]).toMatchObject({ title: '2026_fake', doi: null, year: '', archiveStatus: 'unknown' });
});

it('does not enumerate without read permission and fails closed on revocation', async () => {
	const { directory, entries } = fixture({ paper: metadata });
	vi.mocked(directory.queryPermission).mockResolvedValue('prompt');
	await expect(readArchiveCatalog(directory)).rejects.toMatchObject({ name: 'NotAllowedError' });
	expect(entries).not.toHaveBeenCalled();
	await expect(readArchiveCatalog(fixture({ paper: new DOMException('', 'NotAllowedError') }).directory)).rejects.toMatchObject({ name: 'NotAllowedError' });
});

it('bounds enumeration and explicitly marks partial results', async () => {
	const { directory, read } = fixture(Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [String(i), metadata])));
	const result = await readArchiveCatalog(directory);
	expect(result.truncated).toBe(true); expect(result.entries).toHaveLength(5000); expect(read).toHaveBeenCalledTimes(5000);
});
