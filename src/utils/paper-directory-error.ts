export class PaperDirectoryError extends Error {
	constructor(public readonly reason: 'unsupported' | 'missing' | 'permission' | 'exists' | 'duplicate' | 'index' | 'write' | 'identity' | 'handoff' | 'busy' | 'expired', public readonly folder = '') { super(reason); }
}
