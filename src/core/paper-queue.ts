import browser from '../utils/browser-polyfill';
import { createIcons, Link, Unplug, Play, ExternalLink, X } from 'lucide';
import { PaperTaskTab, queueApi, QueueJob } from '../utils/paper-queue-client';

const endpoint = document.getElementById('endpoint') as HTMLInputElement;
const key = document.getElementById('key') as HTMLInputElement;
const status = document.getElementById('connection')!;
const errorBox = document.getElementById('error')!;
const taskTab = new PaperTaskTab();
const icons = () => createIcons({ icons: { Link, Unplug, Play, ExternalLink, X } });
const showError = (error: unknown) => { errorBox.hidden = false; errorBox.textContent = error instanceof Error ? error.message : String(error); };
let api: ReturnType<typeof queueApi> | undefined, polling = false, active = false, busy = false;
let disconnectRequested = false;
const terminal = new Set(['saved', 'duplicate', 'failed', 'cancelled', 'existing-unverified']);

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
						if (action === 'open') await taskTab.focus(job.id);
						else { await api?.(`/v1/jobs/${job.id}/${action}`, {}); errorBox.hidden = true; if (action === 'skip') await taskTab.finish(job.id); await refresh(); }
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
	if (!api) return;
	const { jobs } = await api('/v1/jobs');
	await taskTab.reconcile(jobs.map((job: QueueJob) => job.id));
	for (const job of jobs as QueueJob[]) if (terminal.has(job.status)) await taskTab.finish(job.id);
	render(jobs);
}

async function tick() {
	if (polling || !active || !api) return;
	polling = true;
	try {
		await refresh(); status.textContent = 'Connected';
		const { job } = await api('/v1/claim', {});
		if (job) {
			busy = true; await refresh();
			try {
				const snapshot = await taskTab.snapshot(job);
				await api(`/v1/jobs/${job.id}/capture`, { ...snapshot, lease: job.lease });
				errorBox.hidden = true;
			} catch (error) {
				await api(`/v1/jobs/${job.id}/pause`, { lease: job.lease, reason: error instanceof Error ? error.message : String(error) }).catch(() => {});
				showError(error);
			} finally { busy = false; }
			await refresh();
		}
	} catch (error) { status.textContent = 'Waiting for local queue'; showError(error); }
	finally { polling = false; if (disconnectRequested) { active = false; disconnectRequested = false; status.textContent = 'Disconnected'; } }
}

async function connect() {
	if (polling) throw new Error('Wait for the current task to finish.');
	api = queueApi(endpoint.value.trim(), key.value.trim());
	await api('/v1/jobs');
	await browser.storage.local.set({ paperQueuePairing: { endpoint: endpoint.value.trim(), key: key.value.trim() } });
	errorBox.hidden = true; active = true; await tick();
}

document.getElementById('pairing')!.addEventListener('submit', event => { event.preventDefault(); connect().catch(showError); });
document.getElementById('disconnect')!.addEventListener('click', () => {
	if (polling) { disconnectRequested = true; status.textContent = 'Disconnecting after current task'; }
	else { active = false; status.textContent = 'Disconnected'; }
});
document.getElementById('forget')!.addEventListener('click', async () => {
	if (polling) { showError(new Error('Disconnect after the current task before forgetting pairing.')); return; }
	active = false; api = undefined; key.value = ''; await browser.storage.local.remove('paperQueuePairing'); status.textContent = 'Disconnected';
});
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
icons();

// A visible extension page owns the loop; no service-worker keepalive or daily-tab scan.
navigator.locks.request('paper-queue-controller', { ifAvailable: true }, async lock => {
	if (!lock) { document.querySelectorAll('button').forEach(button => { button.disabled = true; }); status.textContent = 'Another queue page is open'; return; }
	const saved = (await browser.storage.local.get('paperQueuePairing')).paperQueuePairing as { endpoint?: unknown; key?: unknown } | undefined;
	if (saved && typeof saved.endpoint === 'string' && typeof saved.key === 'string') {
		endpoint.value = saved.endpoint; key.value = saved.key;
		try { api = queueApi(saved.endpoint, saved.key); active = true; } catch (error) { showError(error); }
	}
	await tick();
	await new Promise<void>(() => { setInterval(() => { tick().catch(showError); }, 2500); });
}).catch(showError);
