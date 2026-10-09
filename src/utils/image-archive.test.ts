import { afterEach, describe, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createImageArchive } from './image-archive';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
function mockFetch() {
	const fetcher = vi.fn(async () => new Response(png, { headers: { 'Content-Type': 'image/png' } }));
	vi.stubGlobal('fetch', fetcher);
	return fetcher;
}
afterEach(() => vi.unstubAllGlobals());
describe('manual image ZIP', () => {
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
		expect(Object.keys(files)).toHaveLength(2);
		expect(Object.keys(files).every(key => !key.includes('..'))).toBe(true);
		expect(result.fileName).not.toMatch(/[\\/]/);
	});
	it('resolves relative addresses and keeps edits and caption text', async () => {
		mockFetch();
		const result = await createImageArchive('Edited\n![x](/a.png)\nFigure 1. Caption', 'Paper', 'https://example.org/article');
		const files = unzipSync(result.bytes);
		expect(strFromU8(Object.values(files)[1])).toBe('Edited\n![x](<images/image-1.png>)\nFigure 1. Caption');
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
		expect(fetcher).not.toHaveBeenCalled();
	});
});
