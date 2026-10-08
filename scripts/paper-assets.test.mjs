import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { marked } from 'marked';
import { assetLimits, collectImages, fetchImage, imageExtension, isPublicAddress, localizeImages } from './paper-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDXsAAAAASUVORK5CYII=', 'base64');
const image = { bytes: png, contentType: 'image/png' };
let directory;
before(async () => {
	await mkdir(path.join(root, 'output/browser-fetch/tests'), { recursive: true });
	directory = await mkdtemp(path.join(root, 'output/browser-fetch/tests/assets-'));
});
const options = name => ({ output: path.join(directory, `${name}.md`), url: 'https://publisher.example/article' });

test('finds Markdown, reference and HTML images without interpreting code, frontmatter or plain links as images', () => {
	const markdown = '---\ncover: "![metadata](https://ignore.example/meta)"\n---\n' +
		'[![a *label*](<https://images.example/a(1).png> "title")](https://keep.example)\n' +
		'![Ref][shared] and ![shared][] and ![shared]\n\n[shared]: /b.png "Reference title"\n\n' +
		'`![code](https://ignore.example/code)`\n\n```md\n![fenced](https://ignore.example/fence)\n```\n\n' +
		'<table><tr><td><img alt="raw" src="/c.png?x=1&amp;y=2" srcset="/big.png 2x"></td></tr></table>\n\n' +
		'<pre><img src="/ignore.png"></pre>\n\n![Escaped \\[alt\\]](https://images.example/d.png)';
	const images = collectImages(markdown);
	assert.equal(images.length, 6);
	assert.equal(images[0].url, 'https://images.example/a(1).png');
	assert.equal(images[1].title, 'Reference title');
	assert.equal(images[4].url, '/c.png?x=1&y=2');
	assert.equal(markdown.slice(images[4].start, images[4].end), 'src="/c.png?x=1&amp;y=2"');
});

test('deduplicates sources, writes real bytes, preserves surrounding text and links, and keeps original code and TeX', async () => {
	const url = 'https://images.example/a.png?x=1&y=2';
	const markdown = `Text $x_i + \\alpha$ before [![a](${url} "title")](https://publisher.example/large).\r\n` +
		`\r\n![ref][same]\r\n\r\n[same]: ${url} "reference"\r\n[ordinary][same]\r\n` +
		'\r\n`![code](' + url + ')`\r\n\r\n' + `<table>\r\n<tr><td><img alt='z' src='${url.replace('&', '&amp;')}' srcset='https://images.example/other 2x' width='42'></td></tr>\r\n</table>\r\n`;
	const calls = [];
	const result = await localizeImages(markdown, options('paper space'), { download: async url => { calls.push(url); return image; } });
	assert.deepEqual(calls, [url]);
	assert.equal(result.report.occurrences, 3);
	assert.equal(result.report.downloaded, 1);
	assert.equal(result.report.failed, 0);
	const asset = result.report.items[0];
	assert.equal(asset.occurrences, 3);
	assert.deepEqual(await readFile(asset.file), png);
	assert.ok(asset.relativePath.includes('%20'));
	assert.ok(!result.markdown.includes('srcset='));
	assert.ok(result.markdown.includes('Text $x_i + \\alpha$ before'));
	assert.ok(result.markdown.includes('](https://publisher.example/large).\r\n'));
	assert.ok(result.markdown.includes(`[same]: ${url} "reference"`));
	assert.ok(result.markdown.includes('`![code](' + url + ')`'));
	assert.ok(result.markdown.includes("width='42'"));
	const doc = parseHTML(`<html><body>${marked.parse(result.markdown)}</body></html>`).document;
	assert.deepEqual([...doc.querySelectorAll('img')].map(img => img.getAttribute('src')), Array(3).fill(asset.relativePath));
	assert.equal(doc.querySelector('a[href="' + url + '"]').textContent, 'ordinary');
});

test('retains failed URLs verbatim, limits unique images/bytes, and does not create directories when none succeed', async () => {
	const markdown = '![a](https://images.example/a) ![b](https://images.example/b) ![c](https://images.example/c)';
	const first = await localizeImages(markdown, options('failure'), { download: async () => { throw new Error('Image HTTP 403.'); } });
	assert.equal(first.markdown, markdown);
	assert.equal(first.report.status, 'partial');
	assert.equal(first.report.failed, 3);
	assert.equal(first.report.directory, undefined);
	const limits = { ...assetLimits, maxImages: 2, maxTotalBytes: png.length };
	let calls = 0;
	const second = await localizeImages(markdown, options('limit'), { limits, download: async () => { calls++; return image; } });
	assert.equal(calls, 1);
	assert.equal(second.report.downloaded, 1);
	assert.equal(second.report.failed, 2);
	assert.equal((await readdir(second.report.directory)).length, 1);
	const tooLarge = await localizeImages('![a](https://images.example/a)', options('oversize'), {
		limits: { ...assetLimits, maxBytes: 1 }, download: async () => image,
	});
	assert.equal(tooLarge.report.downloaded, 0);
	assert.match(tooLarge.report.items[0].error, /byte limit/);
});

test('new runs never replace old attachments, including when all later downloads fail', async () => {
	const markdown = '![a](https://images.example/a)';
	const first = await localizeImages(markdown, options('repeat'), { download: async () => image });
	const timestamp = (await stat(first.report.items[0].file)).mtimeMs;
	const second = await localizeImages(markdown, options('repeat'), { download: async () => image });
	assert.notEqual(second.report.directory, first.report.directory);
	await localizeImages(markdown, options('repeat'), { download: async () => { throw new Error('offline'); } });
	assert.deepEqual(await readFile(first.report.items[0].file), png);
	assert.equal((await stat(first.report.items[0].file)).mtimeMs, timestamp);
});

test('rejects non-public addresses, credential URLs and unsupported schemes before download', async () => {
	for (const address of ['127.0.0.1', '10.1.1.1', '192.168.1.1', '169.254.169.254', '100.64.1.1', '224.1.1.1',
		'::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:7f00:1::1', 'not-an-ip']) assert.equal(isPublicAddress(address), false, address);
	for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
	const urls = ['http://127.1/a', 'http://0x7f000001/a', 'http://[::1]/a', 'https://user:pass@images.example/a', 'file:///private.png', 'blob:https://images.example/id', 'data:image/svg+xml,svg'];
	const result = await localizeImages(urls.map(url => `![](${url})`).join('\n'), options('unsafe'), { download: async () => { assert.fail('must not fetch'); } });
	assert.equal(result.report.failed, 7);
	assert.equal(result.report.downloaded, 0);
});

test('validates image MIME and magic bytes instead of URL suffix or Content-Disposition', () => {
	assert.equal(imageExtension(png, 'image/png; charset=binary'), 'png');
	assert.equal(imageExtension(Buffer.from('GIF89aabcdef'), 'image/gif'), 'gif');
	assert.equal(imageExtension(Buffer.from('RIFF0000WEBP0000'), 'image/webp'), 'webp');
	for (const [bytes, type] of [[Buffer.from('<html>login</html>'), 'image/png'], [png, 'text/html'], [Buffer.from('<svg/>'), 'image/svg+xml'], [Buffer.alloc(0), 'image/jpeg']]) {
		assert.throws(() => imageExtension(bytes, type));
	}
});

test('HTTP transport enforces status, MIME, stream size, timeout, redirect limits and redirect address validation', async () => {
	let receivedHeaders;
	const server = createServer((request, response) => {
		receivedHeaders = request.headers;
		if (request.url === '/png') response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="../../outside.exe"' }).end(png);
		else if (request.url === '/redirect') response.writeHead(302, { Location: '/png' }).end();
		else if (request.url === '/private') response.writeHead(302, { Location: 'http://127.0.0.1/private' }).end();
		else if (request.url === '/loop') response.writeHead(302, { Location: '/loop' }).end();
		else if (request.url === '/denied') response.writeHead(403).end('denied');
		else if (request.url === '/html') response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>Login</html>');
		else if (request.url === '/fake') response.writeHead(200, { 'Content-Type': 'image/png' }).end('<html>Login</html>');
		else if (request.url === '/large') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.write(png); response.end(png); }
		else if (request.url === '/length') response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 1000000 }).end(png);
		else if (request.url === '/slow') { /* The client must time out without receiving any response. */ }
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const base = `http://images.example:${server.address().port}`;
	const lookup = (_host, options, callback) => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
	try {
		const fetched = await fetchImage(`${base}/redirect`, { lookup });
		assert.deepEqual(fetched.bytes, png);
		assert.equal(fetched.finalUrl, `${base}/png`);
		assert.equal(receivedHeaders.cookie, undefined);
		assert.equal(receivedHeaders.authorization, undefined);
		for (const [route, pattern] of [['/private', /Private/], ['/loop', /redirect limit/], ['/denied', /HTTP 403/], ['/html', /Content-Type/], ['/fake', /bytes do not match/]]) {
			await assert.rejects(fetchImage(base + route, { lookup }), pattern);
		}
		for (const route of ['/large', '/length']) await assert.rejects(fetchImage(base + route, { lookup, maxBytes: png.length }), /byte limit/);
		await assert.rejects(fetchImage(base + '/slow', { lookup, timeout: 30 }), /abort/i);
		await assert.rejects(fetchImage(`http://localhost:${server.address().port}/png`), /private or reserved/);
	} finally {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
});
