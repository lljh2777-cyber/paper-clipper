export interface FormulaReport {
	status: 'passed' | 'failed' | 'not-applicable';
	scope: string;
	expected: number;
	matched: number;
	missing: string[];
	unsupported: { id: string; reason: string }[];
}
export function mathInventory(document: Document): { element: Element; id: string; math?: Element; latex?: string; block?: boolean; error?: string }[];
export function prepareMath(document: Document): void;
export function retainMathForSnapshot(document: Document): void;
export function checkMathPreservation(document: Document, markdown: string): FormulaReport;
export function assertMathPreserved(document: Document, markdown: string): void;
