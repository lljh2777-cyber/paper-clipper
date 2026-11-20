export const MODEL_VARIABLE_NAMES = ['model', 'modelId', 'modelProvider'];

// Returns true if the variable string (e.g. `model` or `modelId|lower`)
// is an interpreter model variable
export function isModelVariable(variableString: string): boolean {
	const baseName = variableString.split('|')[0].trim();
	return MODEL_VARIABLE_NAMES.includes(baseName);
}
