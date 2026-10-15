import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolated CI profile with the optional grant pre-authorized. The native browser
// consent dialog is NOT covered by this adapter; denial/gesture logic has unit tests.
export async function authorizedDownloadExtension(directory) {
	const profile = path.join(directory, 'profile', 'Default');
	await mkdir(profile, { recursive: true });
	await mkdir(path.join(directory, 'downloads'));
	await writeFile(path.join(profile, 'Preferences'), JSON.stringify({ download: {
		default_directory: path.join(directory, 'downloads'), prompt_for_download: false,
	} }));
	const extension = path.join(directory, 'authorized-extension');
	await cp(fileURLToPath(new URL('../../dev', import.meta.url)), extension, { recursive: true });
	const manifestPath = path.join(extension, 'manifest.json');
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	assert.ok(manifest.optional_permissions.includes('downloads'));
	manifest.optional_permissions = manifest.optional_permissions.filter(permission => permission !== 'downloads');
	manifest.permissions.push('downloads');
	await writeFile(manifestPath, JSON.stringify(manifest));
	return extension;
}

export async function configureZipDownloads(context, page, directory) {
	const destination = path.join(directory, 'downloads');
	const session = await context.newCDPSession(page);
	// CDP's allow/allowAndName delegate bypasses Chrome's extension filename and
	// conflict handling. Restore the real delegate and use this fresh profile's
	// download preference, so naming and no-overwrite assertions remain meaningful.
	await session.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
	return destination;
}

export async function openSavePage(context, trigger) {
	const opening = context.waitForEvent('page').then(page => ({ page, closed: new Promise(resolve => page.once('close', resolve)) }));
	await trigger();
	return opening;
}

export async function readCompletedZip(worker, save, destination) {
	let timer;
	try {
		await Promise.race([save.closed, new Promise((_, reject) => { timer = setTimeout(async () => {
			const status = await save.page.locator('#save-status').textContent().catch(() => 'Save page unavailable');
			reject(new Error(`ZIP did not complete: ${status}`));
		}, 30_000); })]);
	} finally { clearTimeout(timer); }
	const [download] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }));
	assert.equal(download?.state, 'complete');
	assert.equal(path.dirname(download.filename), destination);
	return { bytes: await readFile(download.filename), fileName: path.basename(download.filename), id: download.id };
}
