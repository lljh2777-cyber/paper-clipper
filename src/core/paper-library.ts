import { createIcons, Search, RefreshCw, FolderOpen } from 'lucide';
import { getPaperDirectory } from '../utils/paper-directory';
import { readArchiveCatalog, searchArchives, type ArchiveCatalog, type ReadableDirectory } from '../utils/paper-library';
import { getMessage, setupLanguageAndDirection, translatePage } from '../utils/i18n';

const query = document.getElementById('library-query') as HTMLInputElement;
const sort = document.getElementById('library-sort') as HTMLSelectElement;
const status = document.getElementById('library-status')!;
const results = document.getElementById('library-results')!;
const more = document.getElementById('library-more') as HTMLButtonElement;
const refresh = document.getElementById('library-refresh') as HTMLButtonElement;
const choose = document.getElementById('library-choose') as HTMLButtonElement;
const authorize = document.getElementById('library-authorize') as HTMLButtonElement;
const issues = document.getElementById('library-issues')!;
type Picker = (options: { id: string; mode: 'read' }) => Promise<ReadableDirectory>;
const picker = (window as Window & { showDirectoryPicker?: Picker }).showDirectoryPicker;
let directory: ReadableDirectory | undefined;
let catalog: ArchiveCatalog | undefined;
let visible = 50;
let busy = false;

function render() {
	results.replaceChildren(); more.hidden = true;
	if (!catalog) return;
	const filtered = searchArchives(catalog.entries, query.value, sort.value as 'newest' | 'title' | 'year');
	status.textContent = getMessage('paperLibraryCount', [String(filtered.length), String(catalog.entries.length), String(catalog.skipped), String(catalog.issues.length)]);
	if (!filtered.length) status.textContent += '\n' + getMessage(catalog.entries.length ? 'paperLibraryNoMatches' : 'paperLibraryEmpty');
	if (catalog.truncated) status.textContent += '\n' + getMessage('paperLibraryTruncated');
	const fragment = document.createDocumentFragment();
	for (const entry of filtered.slice(0, visible)) {
		const row = document.createElement('li'); row.className = 'archive-row';
		const title = document.createElement('h3'); title.textContent = entry.title; row.append(title);
		const meta = document.createElement('div'); meta.className = 'archive-meta';
		for (const value of [entry.year || getMessage('paperLibraryUnknownYear'),
			getMessage(`paperLibraryArchive_${entry.archiveStatus}`), getMessage('paperLibraryTranslation', entry.translationStatus)]) {
			const label = document.createElement('span'); label.textContent = value; meta.append(label);
		}
		if (entry.doi) { const doi = document.createElement('span'); doi.className = 'archive-doi'; doi.textContent = entry.doi; meta.append(doi); }
		const folder = document.createElement('p'); folder.className = 'archive-folder'; folder.textContent = `${directory!.name}/${entry.folder}`;
		row.append(meta, folder); fragment.append(row);
	}
	results.append(fragment); more.hidden = filtered.length <= visible;
}

async function scan(action: 'refresh' | 'choose' | 'authorize' = 'refresh') {
	if (busy) return;
	busy = true; refresh.disabled = choose.disabled = authorize.disabled = true;
	catalog = undefined; render(); issues.hidden = true; authorize.hidden = true;
	status.dataset.error = 'false'; status.textContent = getMessage('paperLibraryLoading');
	try {
		if (action === 'choose' && picker) directory = await picker.call(window, { id: 'paper-clipper-library', mode: 'read' });
		document.getElementById('library-directory')!.textContent = directory?.name ?? '';
		if (!directory) { status.textContent = getMessage(picker ? 'paperLibraryNoDirectory' : 'paperDirectoryError_unsupported'); return; }
		if (action === 'authorize') await directory.requestPermission({ mode: 'read' });
		if (await directory.queryPermission({ mode: 'read' }) !== 'granted') {
			authorize.hidden = false; status.textContent = getMessage('paperLibraryPermission'); return;
		}
		catalog = await readArchiveCatalog(directory);
		const list = issues.querySelector('ul')!; list.replaceChildren();
		for (const issue of catalog.issues) {
			const item = document.createElement('li'); item.textContent = `${issue.folder}: ${getMessage(`paperLibraryIssue_${issue.reason}`)}`; list.append(item);
		}
		issues.hidden = catalog.issues.length === 0; visible = 50; render();
	} catch (error) {
		status.dataset.error = 'true';
		status.textContent = getMessage(error instanceof DOMException && error.name === 'AbortError' ? 'paperLibraryCancelled' : 'paperLibraryReadError');
		authorize.hidden = !directory;
	} finally { busy = false; refresh.disabled = false; choose.disabled = !picker; authorize.disabled = false; }
}

async function initialize() {
	await setupLanguageAndDirection(); await translatePage();
	query.setAttribute('aria-label', getMessage('paperLibrarySearch'));
	query.placeholder = getMessage('paperLibrarySearch');
	sort.setAttribute('aria-label', getMessage('paperLibrarySort'));
	refresh.setAttribute('aria-label', getMessage('paperLibraryRefresh'));
	createIcons({ icons: { Search, RefreshCw, FolderOpen } });
	query.addEventListener('input', () => { visible = 50; render(); });
	sort.addEventListener('change', () => { visible = 50; render(); });
	more.addEventListener('click', () => { visible += 50; render(); });
	refresh.addEventListener('click', () => { void scan(); });
	choose.addEventListener('click', () => { void scan('choose'); });
	authorize.addEventListener('click', () => { void scan('authorize'); });
	// Reuse the saved handle, but never request write access or change the default.
	directory = await getPaperDirectory() as unknown as ReadableDirectory | undefined;
	await scan();
}
void initialize().catch(() => { status.dataset.error = 'true'; status.textContent = getMessage('paperLibraryReadError'); });
