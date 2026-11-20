// Recognize obsolete prompt slots without evaluating them as template strings.
export function isLegacyPrompt(expression: string): boolean {
	return /^(?:prompt:\s*)?(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')\s*(?:\||$)/.test(expression);
}
