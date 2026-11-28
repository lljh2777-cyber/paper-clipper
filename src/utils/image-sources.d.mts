export const preprintFigureSelector: string;
export function isHighWirePreprintHost(hostname: string): boolean;
export function preprintFigureSource(figure: Element, page: string | URL): string | null;
export function collectImageSources(document: Document, source: string): Record<string, string>;
export function imageDownloadCandidates(original: string, source: string, sources?: Record<string, string>): string[];
