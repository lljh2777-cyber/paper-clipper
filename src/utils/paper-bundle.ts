import type { ManualExportChecks } from './manual-export-report';

export interface PaperIdentity { doi: string | null; published: string | null }

export function normalizeDoi(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	let doi = value.trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
	try { doi = decodeURIComponent(doi); } catch { return null; }
	return /^10\.\d{4,9}\/[^\s<>"?#]+$/i.test(doi) ? doi.toLowerCase() : null;
}

const safeComponent = (value: string, length: number) => value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
	.replace(/\s+/g, '_').slice(0, length).replace(/[. _]+$/g, '') || 'paper';
export function paperFolderName(title: string, identity: PaperIdentity, id: string): string {
	const year = identity.published?.match(/^\d{4}/)?.[0] ?? 'unknown';
	return `${year}_${safeComponent(title, 44)}__${identity.doi ? safeComponent(identity.doi, 80) : id}`;
}

export async function paperTranslationMetadata(input: { title: string; source: string; identity: PaperIdentity },
	prepared: { files: Record<string, Uint8Array>; checks: ManualExportChecks; imageCount: number }, id: string) {
	const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(prepared.files['paper.md']).buffer);
	return {
		schemaVersion: 1, id, doi: input.identity.doi, title: input.title, published: input.identity.published,
		sourceUrl: input.source, sourceFile: 'paper.md', translationFile: 'paper.zh-CN.md',
		sourceVersion: { algorithm: 'sha256', value: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('') },
		createdAt: new Date().toISOString(), status: 'not-started', model: null, completedSections: [], archiveStatus: 'writing',
		acquisition: { method: 'extension-editor', completeness: prepared.checks.completeness, preservation: prepared.checks.preservation,
			coverage: prepared.checks.coverage, images: prepared.imageCount, checksFile: 'checks.json',
			...(prepared.checks.attachments ? { attachments: prepared.checks.attachments.downloaded, attachmentsReport: 'supplement-report.json' } : {}) },
		translationChecks: 'not-run', humanReview: 'not-reviewed',
	};
}
