// Use explicit DOM associations, never infer figure numbers from image order.
export function collectFigureLinks(document: Document, source: string): Record<string, string> {
	const candidates = new Map<string, Set<string>>();
	for (const figure of Array.from(document.querySelectorAll('figure'))) {
		const images = Array.from(figure.querySelectorAll('img[src]')).map(img => {
			try { return new URL(img.getAttribute('src')!, source).href; } catch { return ''; }
		}).filter(Boolean);
		if (new Set(images).size !== 1) continue;
		for (const element of [figure, ...Array.from(figure.querySelectorAll('[id]'))]) {
			if (!element.id) continue;
			try {
				const url = new URL(source); url.hash = element.id;
				const values = candidates.get(url.href) ?? new Set<string>();
				values.add(images[0]); candidates.set(url.href, values);
			} catch { /* Missing source cannot establish a figure target. */ }
		}
	}
	return Object.fromEntries([...candidates].filter(([, values]) => values.size === 1).map(([url, values]) => [url, [...values][0]]));
}
