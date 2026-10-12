function imageUrl(value, base) {
	try {
		const url = new URL(value, base);
		if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
		url.hash = '';
		return url;
	} catch { return null; }
}

function cellLargeImage(original, preferred, page) {
	const source = imageUrl(original, page), target = imageUrl(preferred, page);
	if (!source || !target || source.origin !== page.origin || target.origin !== page.origin) return false;
	const pattern = /^(\/cms\/.+\/asset\/)[^/]+\/main\.assets\/([a-z0-9]+)(_lrg)?\.(jpe?g|png|webp)$/i;
	const small = source.pathname.match(pattern), large = target.pathname.match(pattern);
	return !!(small && large && !small[3] && large[3] && small[1] === large[1] && small[2] === large[2]);
}

// Keep publisher-declared URLs intact: Cell's large image has a different asset
// ID, so changing a filename alone would invent an address that may not exist.
export function collectImageSources(document, source) {
	const sources = Object.create(null);
	const page = imageUrl(source);
	if (!page || !/(^|\.)cell\.com$/.test(page.hostname)) return sources;
	for (const img of document.querySelectorAll('figure img[src][data-viewer-src]')) {
		const original = img.getAttribute('src'), preferred = img.getAttribute('data-viewer-src');
		if (cellLargeImage(original, preferred, page)) sources[imageUrl(original, page).href] = imageUrl(preferred, page).href;
	}
	return sources;
}

export function imageDownloadCandidates(original, source, sources = {}) {
	const url = imageUrl(original, source), page = imageUrl(source);
	if (!url) return [original];
	if (page && /(^|\.)cell\.com$/.test(page.hostname) && Object.prototype.hasOwnProperty.call(sources, url.href) &&
		cellLargeImage(url.href, sources[url.href], page)) return [imageUrl(sources[url.href], page).href, url.href];
	// This CDN's /full/ route preserves the asset identity while removing lwNNN
	// resizing. Do not transform signed or otherwise unfamiliar query parameters.
	if (url.hostname === 'media.springernature.com' && /^\/lw\d+\/springer-static\/image\/.+\/MediaObjects\/.+\.(png|jpe?g|webp)$/i.test(url.pathname) &&
		[...url.searchParams].every(([key, value]) => key === 'as' && value === 'webp')) {
		const full = new URL(url.href);
		full.pathname = full.pathname.replace(/^\/lw\d+\//, '/full/');
		return [full.href, url.href];
	}
	return [url.href];
}
