// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { collectPaperAttachments, preparePaperAttachments } from './paper-attachments';
import { createImageArchive } from './image-archive';
import { resetAttachmentPicker, selectedPaperAttachments } from './attachment-picker';
import Defuddle from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';
import { prepareDocumentForExtraction } from './publisher-figures';
import * as fixture from '../../scripts/fixtures/paper-attachments.mjs';

vi.mock('./i18n', () => ({ getMessage: (key: string, values: string[]) => `${key}: ${values.join('/')}` }));
afterEach(() => { vi.unstubAllGlobals(); resetAttachmentPicker(); });
const source = 'https://journal.example.org/article';
const item = { url: 'https://journal.example.org/supplement.pdf?Signature=private', label: 'Supplementary information' };
const pdf = '%PDF-1.4\nSynthetic supplementary material';

it('retains the browser fixture links through the existing converter before localizing them', () => {
	const page = new DOMParser().parseFromString(fixture.html, 'text/html');
	const extracted = new Defuddle(prepareDocumentForExtraction(page, fixture.source), { url: fixture.source }).parse();
	const markdown = createMarkdownContent(extracted.content, fixture.source);
	expect(markdown).toContain(fixture.pdfUrl);
	expect(markdown).toContain(fixture.csvUrl);
	expect(markdown).toContain('https://files.example.org/article.pdf');
});

it('discovers explicit supported supplementary links, not the article PDF or arbitrary/executable links', () => {
	document.body.innerHTML = `<a href="/article.pdf">Download PDF</a><a href="/random.csv">Other data</a>
	<a href="/supplement.pdf?Signature=private">Supplementary information</a><a href="/supplement.pdf?Signature=private">Duplicate</a>
	<a href="https://cdn.example.org/a_MOESM1_ESM.xlsx">Download file</a>
	<a data-test="supp-info-link" href="https://static-content.springer.com/esm/art/MOESM1_ESM.pdf">Additional file 1: (download PDF <svg></svg>)</a>
	<a href="/code.exe">Supplementary program</a><a href="http://localhost/supplement.pdf">Supplement</a>`;
	expect(collectPaperAttachments(document, source)).toEqual([
		{ url: item.url, label: 'Supplementary information' },
		{ url: 'https://cdn.example.org/a_MOESM1_ESM.xlsx', label: 'Download file' },
		{ url: 'https://static-content.springer.com/esm/art/MOESM1_ESM.pdf', label: 'Additional file 1: (download PDF)' },
	]);
});

it('starts unchecked, keeps selections bound to the capture and resets on a new page', () => {
	document.body.innerHTML = '<div class="clipper-footer"></div>';
	const snapshot = new DOMParser().parseFromString(`<a href="${item.url}">Supplement &lt;img src=x&gt;</a>`, 'text/html');
	resetAttachmentPicker({ document: snapshot, source });
	expect(selectedPaperAttachments()).toEqual([]);
	expect(document.querySelector('#paper-attachments img')).toBeNull();
	const checkbox = document.querySelector<HTMLInputElement>('#paper-attachments input')!;
	checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
	expect(selectedPaperAttachments()[0].url).toBe(item.url);
	expect(document.querySelector('summary')?.textContent).toContain('1/1');
	resetAttachmentPicker(); expect(selectedPaperAttachments()).toEqual([]);
});

it('does not fetch without a selection and archives selected files and a redacted receipt once', async () => {
	const fetcher = vi.fn(async () => new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } })); vi.stubGlobal('fetch', fetcher);
	expect((await preparePaperAttachments()).count).toBe(0); expect(fetcher).not.toHaveBeenCalled();
	const result = await preparePaperAttachments([item, item]);
	expect(fetcher).toHaveBeenCalledOnce();
	expect(fetcher).toHaveBeenCalledWith(item.url, expect.objectContaining({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }));
	expect(strFromU8(result.files['supplements/attachment-1-supplement.pdf'])).toBe(pdf);
	const report = strFromU8(result.files['supplement-report.json']);
	expect(report).not.toContain('Signature'); expect(JSON.parse(report).contentSafety).toBe('not-assessed');
	expect(JSON.parse(report).items[0].sha256).toMatch(/^[0-9a-f]{64}$/);
});

it('includes attachments in ZIP and localizes only selected links with a consistent final Markdown hash', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } })));
	const markdown = `[Supplement](${item.url})\n\n[Unselected](https://journal.example.org/other.pdf)`;
	const archive = await createImageArchive(markdown, 'Paper', source, undefined, {}, undefined, undefined, {}, [item]);
	const files = unzipSync(archive.bytes); const root = archive.fileName.slice(0, -4);
	const saved = strFromU8(files[`${root}/paper.md`]);
	expect(saved).toContain('[Supplement](<supplements/attachment-1-supplement.pdf>)');
	expect(saved).toContain('[Unselected](https://journal.example.org/other.pdf)');
	const checks = JSON.parse(strFromU8(files[`${root}/checks.json`]));
	const metadata = JSON.parse(strFromU8(files[`${root}/translation.json`]));
	expect(checks.attachments.downloaded).toBe(1);
	expect(checks.artifact.value).toBe(metadata.sourceVersion.value);
	expect(metadata.acquisition.attachmentsReport).toBe('supplement-report.json');
});

it.each(['not a URL', 'https://127.0.0.1/supplement.pdf', 'https://user:pass@journal.example.org/supplement.pdf', 'file:///supplement.pdf', 'https://journal.example.org/supplement.exe'])('rejects unsupported destinations before any fetch: %s', async url => {
	const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
	await expect(preparePaperAttachments([{ ...item, url }])).rejects.toMatchObject({ reason: 'unsupported', attachmentNumber: 1 });
	expect(fetcher).not.toHaveBeenCalled();
});

it.each([
	{ response: () => new Response('Login', { status: 403 }), reason: 'blocked' },
	{ response: () => new Response('Retry', { status: 503 }), reason: 'download' },
	{ response: () => new Response('<html>Login</html>', { headers: { 'Content-Type': 'application/pdf' } }), reason: 'unsupported' },
	{ response: () => new Response(pdf, { headers: { 'Content-Length': String(51 * 1024 * 1024) } }), reason: 'limit' },
	{ response: () => new Response(pdf, { headers: { 'Content-Type': 'text/html' } }), reason: 'unsupported' },
])('fails without publishing on $reason', async ({ response, reason }) => {
	vi.stubGlobal('fetch', vi.fn(async () => response()));
	await expect(preparePaperAttachments([item])).rejects.toMatchObject({ reason, attachmentNumber: 1 });
});

it('enforces the selection limit before fetching', async () => {
	const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
	await expect(preparePaperAttachments(Array(21).fill(item))).rejects.toMatchObject({ reason: 'limit', attachmentNumber: 0 });
	expect(fetcher).not.toHaveBeenCalled();
});

it('keeps containers opaque and rejects disguised login pages and invalid text data', async () => {
	const fetcher = vi.fn(async () => new Response(new Uint8Array([80, 75, 3, 4, 1]), { headers: { 'Content-Type': 'application/zip' } })); vi.stubGlobal('fetch', fetcher);
	expect((await preparePaperAttachments([{ ...item, url: 'https://journal.example.org/supplement.zip' }])).count).toBe(1);
	fetcher.mockResolvedValue(new Response('<!doctype html><html>Login</html>', { headers: { 'Content-Type': 'text/csv' } }));
	await expect(preparePaperAttachments([{ ...item, url: 'https://journal.example.org/source.csv' }])).rejects.toMatchObject({ reason: 'unsupported' });
});

it('downloads multiple attachments concurrently with deterministic numbering', async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	const resolvers: Record<string, () => void> = {};
	const fetcher = vi.fn((url: string) => new Promise<Response>(resolve => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		resolvers[url] = () => {
			inFlight--;
			resolve(new Response(`col\n${url.slice(-5)}`, { headers: { 'Content-Type': 'text/csv' } }));
		};
	}));
	vi.stubGlobal('fetch', fetcher);
	const list = Array.from({ length: 5 }, (_, i) => ({
		url: `https://journal.example.org/table-${i + 1}.csv`,
		label: `Table S${i + 1}`,
	}));
	const pending = preparePaperAttachments(list);
	await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
	expect(maxInFlight).toBe(4);
	for (const index of [4, 3, 2, 1]) resolvers[`https://journal.example.org/table-${index}.csv`]();
	await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5));
	resolvers['https://journal.example.org/table-5.csv']();
	const result = await pending;
	const receipt = JSON.parse(strFromU8(result.files['supplement-report.json']));
	expect(receipt.items.map((entry: { file: string }) => entry.file)).toEqual([
		'supplements/attachment-1-table-1.csv',
		'supplements/attachment-2-table-2.csv',
		'supplements/attachment-3-table-3.csv',
		'supplements/attachment-4-table-4.csv',
		'supplements/attachment-5-table-5.csv',
	]);
});
