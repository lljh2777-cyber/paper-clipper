import { afterEach, describe, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createImageArchive, prepareImageFiles } from './image-archive';
import { paperFolderName } from './paper-bundle';
import { markdownSha256 } from './manual-export-report';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
function mockFetch() {
	const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => new Response(png, { headers: { 'Content-Type': 'image/png' } }));
	vi.stubGlobal('fetch', fetcher);
	return fetcher;
}
afterEach(() => vi.unstubAllGlobals());
describe('manual image ZIP', () => {
	it('localizes figure citations only when their mapped image was archived, preserving labels and unrelated links', async () => {
		mockFetch();
		const source = 'https://www.nature.com/articles/test';
		const input = '---\nsource: https://www.nature.com/articles/test#Fig1\n---\nSee [**1b**](https://www.nature.com/articles/test#Fig1) and [panel][fig].\n\n![Figure](https://example.org/a.png)\n\n[fig]: #Fig1 "Panel"\n\n[Other](https://www.nature.com/articles/other#Fig1) [Missing](#Fig2) ` [code](#Fig1) `';
		const result = await createImageArchive(input, 'Paper', source, undefined, {}, undefined, undefined,
			{ [`${source}#Fig1`]: 'https://example.org/a.png', [`${source}#Fig2`]: 'https://example.org/missing.png' });
		const files = unzipSync(result.bytes);
		const md = strFromU8(files[`${result.fileName.slice(0, -4)}/paper.md`]);
		expect(md).toContain('source: https://www.nature.com/articles/test#Fig1');
		expect(md).toContain('[**1b**](<images/image-1.png>)');
		expect(md).toContain('[panel](<images/image-1.png> "Panel")');
		expect(md).toContain('[Other](https://www.nature.com/articles/other#Fig1) [Missing](#Fig2) ` [code](#Fig1) `');
	});
	it('preserves frontmatter and prose, localizes inline/reference images, deduplicates signed URLs', async () => {
		const fetcher = mockFetch();
		const input = '---\r\ncustom: keep\r\n---\r\n# Paper\n\n![A](https://cdn.example.org/a?Expires=42&Signature=secret "Caption")\n\n![B][fig]\n\n[fig]: https://cdn.example.org/a?Expires=42&Signature=secret\n\n`![code](https://other.example.org/x)`';
		const result = await createImageArchive(input, '../../CON', 'https://example.org/paper');
		const files = unzipSync(result.bytes);
		const md = strFromU8(files[Object.keys(files).find(key => key.endsWith('/paper.md'))!]);
		expect(md).toContain('---\r\ncustom: keep\r\n---\r\n# Paper');
		expect(md).toContain('![A](<images/image-1.png> "Caption")');
		expect(md).toContain('![B](<images/image-1.png>)');
		expect(md).toContain('`![code](https://other.example.org/x)`');
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]).toEqual(['https://cdn.example.org/a?Expires=42&Signature=secret', expect.objectContaining({ credentials: 'omit', redirect: 'error' })]);
		expect(Object.keys(files)).toHaveLength(5);
		expect(Object.keys(files).every(key => !key.split('/').includes('..'))).toBe(true);
		expect(result.fileName).not.toMatch(/[\\/]/);
	});
	it('resolves relative addresses and keeps edits and caption text', async () => {
		mockFetch();
		const result = await createImageArchive('Edited\n![x](/a.png)\nFigure 1. Caption', 'Paper', 'https://example.org/article');
		const files = unzipSync(result.bytes);
		expect(strFromU8(files[Object.keys(files).find(key => key.endsWith('/paper.md'))!])).toBe('Edited\n![x](<images/image-1.png>)\nFigure 1. Caption');
	});
	it.each(['http://127.0.0.1/x', 'http://localhost/x', 'http://192.168.1.2/x', 'file:///tmp/x', 'data:image/png;base64,AA', 'https://user:pass@example.org/a'])('rejects unsupported address %s before requesting', async url => {
		const fetcher = mockFetch();
		await expect(createImageArchive(`![x](${url})`, 'Paper', 'https://example.org')).rejects.toMatchObject({ reason: 'unsupported' });
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('rejects HTML media rather than silently leaving remote images', async () => {
		mockFetch();
		await expect(createImageArchive('<img src="https://example.org/a">', 'Paper', 'https://example.org')).rejects.toMatchObject({ reason: 'unsupported' });
	});
	it('rejects login HTML even when mislabeled as an image', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Login</html>', { headers: { 'Content-Type': 'image/png' } })));
		await expect(createImageArchive('![x](https://example.org/a)', 'Paper', 'https://example.org')).rejects.toMatchObject({ reason: 'unsupported', imageNumber: 1 });
	});
	it('fails atomically when a later image cannot be fetched', async () => {
		const fetcher = mockFetch();
		fetcher.mockResolvedValueOnce(new Response(png, { headers: { 'Content-Type': 'image/png' } })).mockRejectedValueOnce(new Error('private URL should not leak'));
		await expect(createImageArchive('![x](https://example.org/a)\n![y](https://example.org/b)', 'Paper', 'https://example.org')).rejects.toMatchObject({ reason: 'download', imageNumber: 2, message: 'download' });
	});
	it('rejects oversized responses and too many images', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(png, { headers: { 'Content-Length': String(21 * 1024 * 1024) } })));
		await expect(createImageArchive('![x](https://example.org/a)', 'Paper', 'https://example.org')).rejects.toMatchObject({ reason: 'limit' });
		await expect(createImageArchive(Array.from({ length: 201 }, (_, i) => `![x](https://example.org/${i})`).join('\n'), 'Paper', 'https://example.org')).rejects.toMatchObject({ reason: 'limit' });
	});
	it('exports image-free notes without network requests', async () => {
		const fetcher = mockFetch();
		const result = await createImageArchive('My note', 'Paper', 'https://example.org');
		expect(result.imageCount).toBe(0);
		const files = unzipSync(result.bytes);
		const root = result.fileName.slice(0, -4);
		expect(root).toMatch(/^unknown_Paper__[0-9a-f-]+$/);
		expect(Object.keys(files).sort()).toEqual(['checks.json', 'images/', 'paper.md', 'translation.json'].map(name => `${root}/${name}`));
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('uses shared directory naming and hashes the localized source for translation', async () => {
		mockFetch();
		const identity = { doi: 'https://doi.org/10.1234/EXAMPLE', published: '2026-10-15' };
		const result = await createImageArchive('![A](https://example.org/a.png)', 'A short title', 'https://example.org', undefined, {}, undefined, identity);
		const files = unzipSync(result.bytes);
		const root = result.fileName.slice(0, -4);
		const metadata = JSON.parse(strFromU8(files[`${root}/translation.json`]));
		const checks = JSON.parse(strFromU8(files[`${root}/checks.json`]));
		expect(root).toBe(paperFolderName('A short title', { ...identity, doi: '10.1234/example' }, metadata.id));
		expect(metadata).toMatchObject({ schemaVersion: 1, doi: '10.1234/example', published: identity.published,
			sourceFile: 'paper.md', translationFile: 'paper.zh-CN.md', status: 'not-started', archiveStatus: 'complete',
			acquisition: { checksFile: 'checks.json', images: 1, completeness: checks.completeness, preservation: checks.preservation, coverage: checks.coverage } });
		expect(metadata.sourceVersion).toEqual({ algorithm: 'sha256', value: await markdownSha256(strFromU8(files[`${root}/paper.md`])) });
		expect(metadata.sourceVersion.value).toBe(checks.artifact.value);
		expect(files[`${root}/paper.zh-CN.md`]).toBeUndefined();
	});
	it('rejects invalid explicit DOI before downloading images', async () => {
		const fetcher = mockFetch();
		await expect(createImageArchive('![A](https://example.org/a.png)', 'Paper', 'https://example.org', undefined, {}, undefined,
			{ doi: '../bad', published: null })).rejects.toThrow('Invalid paper DOI');
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each(['image', 'esm'])('prefers full-size Nature %s images and records the chosen source', async kind => {
		const fetcher = mockFetch();
		const small = `https://media.springernature.com/lw685/springer-static/${kind}/art%3A10.1234%2Ftest/MediaObjects/Fig1.png`;
		const markdown = `![Figure 1](${small})\n\nOriginal caption.`;
		const prepared = await prepareImageFiles(markdown, 'https://www.nature.com/articles/test');
		expect(fetcher.mock.calls[0][0]).toBe(small.replace('/lw685/', '/full/'));
		expect(strFromU8(prepared.files['paper.md'])).toBe('![Figure 1](<images/image-1.png>)\n\nOriginal caption.');
		expect(JSON.parse(strFromU8(prepared.files['image-report.json'])).items).toEqual([{ file: 'images/image-1.png', selection: 'preferred' }]);
	});
	it.each(['denied', 'invalid-image', 'oversize'])('falls back once and records %s high-resolution failures', async failure => {
		const fetcher = mockFetch();
		const small = 'https://www.cell.com/cms/10.1234/test/asset/small/main.assets/gr1.png';
		const large = 'https://www.cell.com/cms/10.1234/test/asset/large/main.assets/gr1_lrg.png';
		fetcher.mockResolvedValueOnce(failure === 'denied' ? new Response('Denied', { status: 403 }) :
			failure === 'invalid-image' ? new Response('Login', { headers: { 'Content-Type': 'image/png' } }) :
			new Response(png, { headers: { 'Content-Length': String(21 * 1024 * 1024) } }));
		const prepared = await prepareImageFiles(`![A](${small})\n![B](${small})`, 'https://www.cell.com/cell/fulltext/test', undefined, { [small]: large });
		expect(fetcher.mock.calls.map(call => call[0])).toEqual([large, small]);
		expect(prepared.imageCount).toBe(1);
		expect(prepared.files['images/image-1.png']).toEqual(png);
		expect(JSON.parse(strFromU8(prepared.files['image-report.json'])).items[0].selection).toBe('original-fallback');
	});
});
