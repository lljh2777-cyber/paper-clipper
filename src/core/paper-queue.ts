import browser from '../utils/browser-polyfill';
import { createIcons, Link, Unplug, Play, ExternalLink, X, RotateCw } from 'lucide';
import { QueueJob } from '../utils/paper-queue-client';

const endpoint = document.getElementById('endpoint') as HTMLInputElement;
const key = document.getElementById('key') as HTMLInputElement;
const status = document.getElementById('connection')!;
const errorBox = document.getElementById('error')!;
const icons = () => createIcons({ icons: { Link, Unplug, Play, ExternalLink, X, RotateCw } });
const showError = (error: unknown) => { errorBox.hidden = false; errorBox.textContent = error instanceof Error ? error.message : String(error); };
let busy = false;

async function command(op: string, data: Record<string, string> = {}) {
	const result = await browser.runtime.sendMessage({ action: 'paperQueue', op, ...data }) as { error?: string; state: { status: string; jobs: QueueJob[]; busy: boolean; error?: string; pairingCode?: string } } | undefined;
	if (!result || result.error) throw new Error(result?.error ?? 'Background queue unavailable. Reload the updated extension.');
	return result.state;
}

function render(jobs: QueueJob[]) {
	document.getElementById('count')!.textContent = String(jobs.length);
	const container = document.getElementById('jobs')!; container.replaceChildren();
	for (const job of jobs) {
		const row = document.createElement('article'); row.className = 'task';
		const attention = ['claimed', 'paused', 'needs-access'].includes(job.status);
		row.dataset.attention = String(attention);
		const content = document.createElement('div'), title = document.createElement('h3'), state = document.createElement('span');
		title.textContent = job.query; state.className = 'state'; state.textContent = job.status;
		content.append(title, state);
		const quality = job.result?.conversion?.quality;
		const text = job.result?.output || job.result?.error || job.error || job.result?.nextStep;
		if (text) { const detail = document.createElement('p'); detail.className = 'details'; detail.textContent = text; content.append(detail); }
		if (quality) { const detail = document.createElement('p'); detail.className = 'details'; detail.textContent = `Completeness: ${quality.completeness?.status ?? 'unchecked'} | Preservation: ${quality.preservation?.status ?? 'unverified'} | Coverage: ${quality.coverage?.status ?? 'not-run'}`; content.append(detail); }
		row.append(content);
		if (attention) {
			const controls = document.createElement('div'); controls.className = 'actions';
			for (const [label, icon, action] of [['Open task tab', 'external-link', 'open'], ['Resume after review', 'play', 'resume'], ['Skip task', 'x', 'skip']]) {
				const button = document.createElement('button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', `${label}: ${job.query}`);
				const symbol = document.createElement('i'); symbol.dataset.lucide = icon; button.append(symbol); button.disabled = busy && action !== 'open';
				button.addEventListener('click', async () => {
					try {
						await command(action, { jobId: job.id }); errorBox.hidden = true; await refresh();
					} catch (error) { showError(error); }
				}); controls.append(button);
			}
			row.append(controls);
		}
		container.append(row);
	}
	if (!jobs.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No tasks'; container.append(empty); }
	icons();
}

async function refresh() {
	let state = await command('status');
	if (state.pairingCode && !state.busy) state = await command('pair-status');
	busy = state.busy; status.textContent = state.status; render(state.jobs);
	const confirmation = document.getElementById('pair-code')!;
	confirmation.hidden = !state.pairingCode; confirmation.textContent = state.pairingCode ? `Confirmation code: ${state.pairingCode}` : '';
	(document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled = busy || !!state.pairingCode;
	(document.getElementById('reset-pairing') as HTMLButtonElement).disabled = busy;
	(document.getElementById('forget') as HTMLButtonElement).disabled = busy;
	if (state.error) showError(new Error(state.error)); else errorBox.hidden = true;
	if (state.status === 'Re-pair required') key.value = '';
}

async function connect() {
	await command('connect', { endpoint: endpoint.value.trim(), key: key.value.trim() });
	await refresh();
}

document.getElementById('pairing')!.addEventListener('submit', event => { event.preventDefault(); connect().catch(showError); });
document.getElementById('disconnect')!.addEventListener('click', () => {
	command('disconnect').then(refresh).catch(showError);
});
document.getElementById('forget')!.addEventListener('click', async () => {
	try { await command('forget'); key.value = ''; await refresh(); } catch (error) { showError(error); }
});
document.getElementById('reset-pairing')!.addEventListener('click', async () => {
	if (busy) { showError(new Error('Wait for the current task before resetting pairing.')); return; }
	if (!window.confirm('Reset this local queue pairing? Other controllers must re-pair. Unfinished captures will pause. Publisher login and saved notes are unchanged.')) return;
	try {
		await command('reset'); await loadPairing();
		const notice = document.getElementById('pairing-notice')!;
		notice.hidden = false; notice.textContent = 'Pairing reset. This controller is updated; other controllers must re-pair.';
		await refresh();
	} catch (error) { showError(error); }
});
icons();

async function loadPairing() {
	const saved = (await browser.storage.local.get('paperQueuePairing')).paperQueuePairing as { endpoint?: unknown; key?: unknown } | undefined;
	if (saved && typeof saved.endpoint === 'string' && typeof saved.key === 'string') {
		endpoint.value = saved.endpoint; key.value = '';
	} else key.value = '';
}
// Views never claim or capture. Closing every view leaves the background controller running.
loadPairing().then(refresh).catch(showError);
setInterval(() => { refresh().catch(showError); }, 2500);
