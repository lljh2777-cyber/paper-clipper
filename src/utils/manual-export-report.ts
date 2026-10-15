export type ManualCheck = {
	status: 'passed' | 'failed' | 'not-covered';
	scope: string;
	expected: number;
	matched: number;
	issues: { id: string; reason: string }[];
	reason?: string;
};
export type ManualChecks = Record<'captions' | 'references' | 'extendedImages' | 'math', ManualCheck>;
export interface ManualExportChecks {
	schemaVersion: 1;
	completeness: 'not-assessed';
	preservation: 'passed-within-scope' | 'attention-required' | 'not-assessed';
	coverage: 'partial-source' | 'not-assessed';
	source: 'captured-page' | 'unavailable';
	changes: { template: 'changed' | 'unchanged' | 'unknown'; editor: 'changed' | 'unchanged' | 'unknown' };
	stages: { extraction: ManualChecks; template: ManualChecks; output: ManualChecks };
	limitations: string[];
}
export const manualCheckLimitations = [
	'Not proof of full-text access or article completeness.',
	'Checks cover only the declared source structures, not all prose, tables or equation formats.',
	'Changed content may come from templates, selections, highlights, AI or editing; intent is not inferred.',
	'Image MIME/signature checks do not establish visual quality.',
];
export function unassessedManualExportChecks(): ManualExportChecks {
	const check = (scope: string): ManualCheck => ({ status: 'not-covered', scope, expected: 0, matched: 0, issues: [], reason: 'source-snapshot-unavailable' });
	const checks = (): ManualChecks => ({ captions: check('captions'), references: check('references'), extendedImages: check('extendedImages'), math: check('math') });
	return { schemaVersion: 1, completeness: 'not-assessed', preservation: 'not-assessed', coverage: 'not-assessed', source: 'unavailable',
		changes: { template: 'unknown', editor: 'unknown' }, stages: { extraction: checks(), template: checks(), output: checks() }, limitations: [...manualCheckLimitations] };
}
export const manualChecksMessageKey = (checks?: ManualExportChecks) => checks?.preservation === 'attention-required' ? 'manualChecksAttention' :
	checks?.preservation === 'passed-within-scope' ? 'manualChecksScoped' : 'manualChecksUnassessed';

export const markdownSha256 = async (markdown: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(markdown))))
	.map(byte => byte.toString(16).padStart(2, '0')).join('');

// Only this compact, content-bound report crosses the save-page handoff.
export interface ManualExportCheckContext { inputSha256: string; report: ManualExportChecks }
