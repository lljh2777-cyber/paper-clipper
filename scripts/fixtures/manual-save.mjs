import assert from 'node:assert/strict';

export async function configurePaperFolder(context, origin) {
	const settings = await context.newPage();
	await settings.goto(origin + '/settings.html');
	await settings.evaluate(() => {
		window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('QA', { create: true });
	});
	await settings.locator('#choose-paper-directory').click();
	await settings.locator('#paper-directory-name').filter({ hasText: 'QA' }).waitFor();
	await settings.close();
}

export async function countZipFiles(worker) {
	return worker.evaluate(async () => {
		const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('QA');
		let count = 0;
		for await (const key of root.keys()) if (key.endsWith('.zip')) count++;
		return count;
	});
}

export async function readZipFile(worker, name) {
	return Buffer.from(await worker.evaluate(async name => {
		const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('QA');
		const file = await (await root.getFileHandle(name)).getFile();
		return [...new Uint8Array(await file.arrayBuffer())];
	}, name));
}

export async function openSavePage(context, trigger) {
	const opening = context.waitForEvent('page').then(page => ({ page, closed: new Promise(resolve => page.once('close', resolve)) }));
	await trigger();
	return opening;
}

export async function readCompletedZip(worker, save) {
	let timer;
	try {
		await Promise.race([save.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ZIP save did not complete')), 30_000); })]);
	} finally { clearTimeout(timer); }
	const result = await worker.evaluate(async () => (await chrome.storage.session.get('paperSaveLastResult')).paperSaveLastResult);
	assert.ok(['saved', 'saved-warning'].includes(result.state));
	const name = result.message.split('\n')[0].split('/').pop();
	assert.ok(name.endsWith('.zip'));
	return { bytes: await readZipFile(worker, name), fileName: name };
}
