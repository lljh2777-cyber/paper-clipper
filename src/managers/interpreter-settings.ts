// Older settings backups may contain model credentials. Drop them at both boundaries.
export function withoutInterpreterSettings<T extends Record<string, unknown>>(settings: T) {
	const { interpreter_settings: discarded, ...rest } = settings;
	return rest;
}
