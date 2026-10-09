import browser from './browser-polyfill';
import { OwnedPaperTab, PaperTaskTab, queueApi, queueEndpoint, QueueJob } from './paper-queue-client';

const alarmName = 'paper-queue-poll';
type Pairing = { endpoint: string; key: string; enabled?: boolean };
type Pending = { jobId: string; lease: string; phase: 'capturing' | 'submitting' | 'pausing'; reason?: string };
type View = { status: string; jobs: QueueJob[]; busy: boolean; error?: string; endpoint?: string };
const terminal = new Set(['saved', 'duplicate', 'failed', 'cancelled', 'existing-unverified']);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const code = (error: unknown) => error && typeof error === 'object' && 'status' in error ? error.status : undefined;

export class PaperQueueController {
	private busy = false;
	private view: View = { status: 'Disconnected', jobs: [], busy: false };
	constructor(private tabs = new PaperTaskTab(undefined, {
		load: async () => (await browser.storage.session.get('paperQueueTab')).paperQueueTab as OwnedPaperTab | undefined,
		save: async value => { if (value) await browser.storage.session.set({ paperQueueTab: value }); else await browser.storage.session.remove('paperQueueTab'); },
	}), private makeApi = queueApi) {}
	private async pairing(): Promise<Pairing | undefined> { return (await browser.storage.local.get('paperQueuePairing')).paperQueuePairing as Pairing | undefined; }
	private async pending(): Promise<Pending | undefined> { return (await browser.storage.local.get('paperQueuePending')).paperQueuePending as Pending | undefined; }
	private async remember(value?: Pending) {
		if (value) await browser.storage.local.set({ paperQueuePending: value }); else await browser.storage.local.remove('paperQueuePending');
	}
	private async publish(change: Partial<View>) {
		this.view = { ...this.view, ...change, busy: this.busy };
		await browser.storage.session.set({ paperQueueView: this.view });
	}
	async status(): Promise<View> { return { ...this.view, busy: this.busy }; }
	private async failed(error: unknown) {
		if (code(error) === 401) {
			await browser.storage.local.remove('paperQueuePairing'); await browser.alarms.clear(alarmName);
			await this.publish({ status: 'Re-pair required', error: message(error) });
		} else await this.publish({ status: 'Waiting for local queue', error: message(error) });
	}
	async wake() {
		if (this.busy) return;
		this.busy = true;
		try {
			const pairing = await this.pairing();
			if (!pairing) return;
			const api = this.makeApi(pairing.endpoint, pairing.key);
			let jobs: QueueJob[] = (await api('/v1/jobs')).jobs;
			await this.tabs.reconcile(jobs.map(job => job.id));
			for (const job of jobs) if (terminal.has(job.status)) await this.tabs.finish(job.id);
			await this.publish({ jobs, endpoint: pairing.endpoint, status: pairing.enabled === false ? 'Disconnected' : 'Connected', error: undefined });
			let pending = await this.pending();
			let job = pending && jobs.find(item => item.id === pending?.jobId);
			if (pending && (!job || !['claimed', 'processing'].includes(job.status))) { await this.remember(); pending = undefined; }
			if (pairing.enabled === false) return;
			if (job?.status === 'processing') return;
			if (pending && job?.status === 'claimed') {
				// Never replay an uncertain submission or adopt tab IDs from an earlier browser session.
				if (pending.phase !== 'capturing' || !await this.tabs.owns(job.id)) {
					await api(`/v1/jobs/${job.id}/pause`, { lease: pending.lease, reason: pending.reason ?? 'Interrupted task. Check the report and Resume explicitly; HTML was not automatically resubmitted.' });
					await this.remember();
					await this.publish({ jobs: (await api('/v1/jobs')).jobs }); return;
				}
				job = { ...job, lease: pending.lease };
			} else {
				job = (await api('/v1/claim', {})).job;
				if (!job) return;
				pending = { jobId: job.id, lease: job.lease!, phase: 'capturing' };
				await this.remember(pending);
			}
			await this.publish({ jobs: (await api('/v1/jobs')).jobs });
			try {
				const snapshot = await this.tabs.snapshot(job);
				await this.remember({ ...pending!, phase: 'submitting' });
				await api(`/v1/jobs/${job.id}/capture`, { ...snapshot, lease: pending!.lease });
			} catch (error) {
				if (code(error) === 401) throw error;
				// A timeout may leave a conversion running locally. The next wake only reconciles it.
				if ((await this.pending())?.phase === 'capturing') {
					await this.remember({ ...pending!, phase: 'pausing', reason: message(error) });
					await api(`/v1/jobs/${job.id}/pause`, { lease: pending!.lease, reason: message(error) });
					await this.remember();
				}
				await this.publish({ error: message(error) });
			}
			jobs = (await api('/v1/jobs')).jobs;
			for (const item of jobs) if (terminal.has(item.status)) await this.tabs.finish(item.id);
			if (!jobs.some(item => item.id === job!.id && ['claimed', 'processing'].includes(item.status))) await this.remember();
			await this.publish({ jobs });
		} catch (error) { await this.failed(error); }
		finally {
			this.busy = false;
			await this.publish((await this.pairing())?.enabled === false ? { status: 'Disconnected' } : {});
		}
	}
	async command(request: { op: string; endpoint?: string; key?: string; jobId?: string }) {
		if (request.op === 'status') return this.status();
		if (request.op === 'open' && request.jobId) { await this.tabs.focus(request.jobId); return this.status(); }
		if (request.op === 'disconnect') {
			const pairing = await this.pairing();
			if (pairing) await browser.storage.local.set({ paperQueuePairing: { ...pairing, enabled: false } });
			await browser.alarms.clear(alarmName);
			await this.publish({ status: this.busy ? 'Disconnecting after current task' : 'Disconnected' }); return this.status();
		}
		if (this.busy) throw new Error('Wait for the current task to finish.');
		this.busy = true;
		try {
			const pairing = await this.pairing();
			if (request.op === 'connect') {
				const endpoint = queueEndpoint(request.endpoint ?? ''), key = request.key ?? '';
				const result = await this.makeApi(endpoint, key)('/v1/jobs');
				await browser.storage.local.set({ paperQueuePairing: { endpoint, key, enabled: true } });
				await this.publish({ status: 'Connected', endpoint, jobs: result.jobs, error: undefined });
				await this.ensureAlarm();
			} else if (request.op === 'forget') {
				await browser.storage.local.remove('paperQueuePairing'); await browser.alarms.clear(alarmName);
				await this.publish({ status: 'Disconnected', jobs: [], error: undefined });
			} else {
				if (!pairing) throw new Error('Pair the local queue first.');
				const api = this.makeApi(pairing.endpoint, pairing.key);
				if (request.op === 'reset') {
					try {
						const result = await api('/v1/pairing/reset', {});
						await browser.storage.local.set({ paperQueuePairing: { ...pairing, key: result.key } });
						await this.remember();
					} catch (error) {
						if (code(error) !== 409) { await browser.storage.local.remove('paperQueuePairing'); await browser.alarms.clear(alarmName); await this.publish({ status: 'Re-pair required' }); }
						throw error;
					}
				} else if (['resume', 'skip'].includes(request.op) && /^[a-f0-9-]+$/.test(request.jobId ?? '')) {
					await api(`/v1/jobs/${request.jobId}/${request.op}`, {});
					await this.remember();
					if (request.op === 'skip') await this.tabs.finish(request.jobId!);
				} else throw new Error('Unknown queue command.');
			}
			return this.status();
		} finally { this.busy = false; await this.publish({}); }
	}
	async ensureAlarm() {
		const pairing = await this.pairing();
		if (!pairing || pairing.enabled === false) { await browser.alarms.clear(alarmName); return; }
		if (!await browser.alarms.get(alarmName)) await browser.alarms.create(alarmName, { periodInMinutes: 1 });
	}
}

export function isQueueSender(sender: browser.Runtime.MessageSender) {
	return sender.id === browser.runtime.id && sender.url === browser.runtime.getURL('paper-queue.html');
}

export function installPaperQueueBackground() {
	// This path is Chromium-only. Other extension builds keep their existing behavior.
	if (!browser.runtime.getURL('').startsWith('chrome-extension:') || !browser.alarms || !browser.storage.session) return;
	const controller = new PaperQueueController();
	let scheduled: ReturnType<typeof setTimeout> | undefined;
	const wake = () => {
		clearTimeout(scheduled); scheduled = undefined;
		controller.wake().then(async () => {
			const state = await controller.status();
			if (!state.busy && state.status === 'Connected' && state.jobs.some(job => ['queued', 'processing'].includes(job.status)) && !state.jobs.some(job => ['paused', 'needs-access', 'claimed'].includes(job.status))) scheduled = setTimeout(wake, 2500);
		}).catch(() => {});
	};
	browser.runtime.onMessage.addListener((request: unknown, sender) => {
		if (!request || typeof request !== 'object' || !('action' in request) || request.action !== 'paperQueue') return;
		if (!isQueueSender(sender)) return Promise.resolve({ error: 'Queue controls require the extension queue page.' });
		if (!('op' in request) || typeof request.op !== 'string') return Promise.resolve({ error: 'Invalid queue command.' });
		return controller.command(request as { op: string }).then(state => {
			if (['connect', 'resume', 'skip', 'reset'].includes(request.op as string)) wake();
			return { state };
		}).catch(error => ({ error: message(error) }));
	});
	browser.alarms.onAlarm.addListener(alarm => { if (alarm.name === alarmName) wake(); });
	browser.runtime.onStartup.addListener(() => { controller.ensureAlarm().then(wake).catch(() => {}); });
	controller.ensureAlarm().then(wake).catch(() => {});
}
