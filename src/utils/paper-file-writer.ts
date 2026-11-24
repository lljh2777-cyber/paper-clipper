export async function exists(parent: FileSystemDirectoryHandle, name: string): Promise<boolean> {
	try { await parent.getDirectoryHandle(name); return true; }
	catch (error) {
		if (error instanceof DOMException && error.name === 'NotFoundError') return false;
		if (error instanceof DOMException && error.name === 'TypeMismatchError') return true;
		throw error;
	}
}
export async function writeFile(directory: FileSystemDirectoryHandle, name: string, contents: string | Uint8Array): Promise<void> {
	const file = await directory.getFileHandle(name, { create: true });
	const writer = await file.createWritable();
	try {
		await writer.write(typeof contents === 'string' ? contents : new Uint8Array(contents).buffer);
		await writer.close();
	} catch (error) { await writer.abort().catch(() => {}); throw error; }
}

// The existence check and allocation share a lock across extension save tabs.
export async function saveNewPaperFile(directory: FileSystemDirectoryHandle, name: string, contents: string | Uint8Array): Promise<string> {
	return navigator.locks.request('paper-clipper-file-write', async () => {
		const dot = name.lastIndexOf('.');
		let candidate = name;
		for (let version = 2; await exists(directory, candidate); version++) {
			candidate = name.slice(0, dot) + ' (' + version + ')' + name.slice(dot);
		}
		await writeFile(directory, candidate, contents);
		return candidate;
	});
}
