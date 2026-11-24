import assert from 'node:assert/strict';
import { openSavePage } from './manual-save.mjs';

export async function checkPlosFigureSave(context, worker, origin, png) {
	const doi = '10.1371/journal.pone.0123456';
	const source = `https://journals.plos.org/plosone/article?id=${doi}`;
	const image = `https://journals.plos.org/plosone/article/figure/image?size=inline&id=${doi}.g001`;
	const storage = 'https://corpus-prod.f505aadad1e46610c8f8563037eb3c4b.r2.cloudflarestorage.com';
	const target = `${storage}/${doi}/1/pone.0123456.g001.PNG_I`;
	const forbidden = 'https://other.example.org/image.png';
	const article = await context.newPage();
	await article.route(source, route => route.fulfill({ contentType: 'text/html', body:
		'<title>PLOS redirect test</title><article><h1>PLOS redirect test</h1><p>' + 'Synthetic figure observations. '.repeat(16) + '</p></article>' }));
	await article.goto(source);
	const opening = context.waitForEvent('page');
	await worker.evaluate(url => chrome.tabs.create({ url, active: false }), origin + '/popup.html');
	const popup = await opening;
	await popup.waitForFunction(() => document.querySelector('#note-content-field')?.value.includes('Synthetic figure'));
	await popup.locator('#note-content-field').fill(`![First](${image})\n\n![Repeated](${image})`);
	await popup.locator('#use-default-paper-directory').uncheck();
	const save = await openSavePage(context, () => popup.locator('#clip-btn').click());
	const authorize = save.page.locator('#authorize-save');
	await authorize.waitFor();
	await save.page.evaluate(() => {
		window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('PLOS', { create: true });
	});
	const cdp = await context.newCDPSession(save.page);
	await cdp.send('Fetch.enable', { patterns: [image, storage + '/*', forbidden].map(urlPattern => ({ urlPattern })) });
	const visited = [];
	let mode = 'external';
	cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
		visited.push(request.url);
		let redirect;
		if (request.url === image) redirect = mode === 'wrong-figure' ? target.replace('g001.PNG', 'g002.PNG') : target;
		else if (request.url === target && mode === 'external') redirect = forbidden;
		await cdp.send('Fetch.fulfillRequest', redirect ? { requestId, responseCode: 302, responseHeaders: [{ name: 'Location', value: redirect }] } :
			{ requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: png.toString('base64') });
	});
	const retry = save.page.locator('#retry-save');
	for (const failure of ['external', 'wrong-figure']) {
		mode = failure;
		await (mode === 'external' ? authorize : retry).click();
		await save.page.locator('#save-status[data-error="true"]').waitFor();
		assert.deepEqual(visited.splice(0), [image, mode === 'external' ? target : target.replace('g001.PNG', 'g002.PNG')]);
		assert.equal(await worker.evaluate(async () => {
			const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('PLOS');
			return (await dir.keys().next()).done;
		}), true);
	}
	mode = 'valid';
	await Promise.all([save.page.waitForEvent('close', { timeout: 30_000 }), retry.click()]);
	assert.deepEqual(visited, [image, target]);
	const result = await worker.evaluate(async () => {
		const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('PLOS');
		const paper = (await dir.values().next()).value;
		const images = await paper.getDirectoryHandle('images');
		const file = await (await images.getFileHandle('image-1.png')).getFile();
		return { bytes: [...new Uint8Array(await file.arrayBuffer())], md: await (await (await paper.getFileHandle('paper.md')).getFile()).text() };
	});
	assert.deepEqual(Buffer.from(result.bytes), png);
	assert.equal(result.md.match(/\(<images\/image-1\.png>\)/g)?.length, 2);
	await popup.close();
	await article.close();
}
