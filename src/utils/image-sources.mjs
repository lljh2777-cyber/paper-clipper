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

export const preprintFigureSelector = '.fig.type-figure';
export const isHighWirePreprintHost = hostname => /^(?:www\.)?(?:bio|med)rxiv\.org$/.test(hostname);

export function preprintFigureSource(figure, page) {
	const image = [...figure.querySelectorAll('.fig-inline-img img.fragment-image')].find(img => !img.closest('noscript'));
	for (const attribute of ['data-src', 'src']) {
		const value = image?.getAttribute(attribute);
		const url = value && imageUrl(value, page);
		if (url) return url.href;
	}
	return null;
}

function preprintLargeImage(original, preferred, page) {
	const source = imageUrl(original, page), target = imageUrl(preferred, page);
	const publisher = page.hostname.replace(/^www\./, '').split('.')[0];
	return !!(source && target && source.origin === page.origin && target.origin === page.origin &&
		!source.search && !target.search && source.pathname.startsWith(`/content/${publisher}/`) &&
		/^\/content\/(?:bio|med)rxiv\/early\/\d{4}\/\d{2}\/\d{2}\/[\d.]+\/F\d+\.medium\.gif$/.test(source.pathname) &&
		target.pathname === source.pathname.replace(/\.medium\.gif$/, '.large.jpg'));
}

// Keep publisher-declared URLs intact: Cell's large image has a different asset
// ID, so changing a filename alone would invent an address that may not exist.
export function collectImageSources(document, source) {
	const sources = Object.create(null);
	const page = imageUrl(source);
	if (!page) return sources;
	if (isHighWirePreprintHost(page.hostname)) {
		for (const figure of document.querySelectorAll(`.article.fulltext-view ${preprintFigureSelector}`)) {
			const original = preprintFigureSource(figure, page);
			const preferred = figure.querySelector('a.highwire-figure-link-newtab[href]')?.getAttribute('href');
			if (original && preferred && preprintLargeImage(original, preferred, page)) sources[original] = imageUrl(preferred, page).href;
		}
		return sources;
	}
	if (!/(^|\.)cell\.com$/.test(page.hostname)) return sources;
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
	if (page && isHighWirePreprintHost(page.hostname) && Object.prototype.hasOwnProperty.call(sources, url.href) &&
		preprintLargeImage(url.href, sources[url.href], page)) return [imageUrl(sources[url.href], page).href, url.href];
	// This CDN's /full/ route preserves the asset identity while removing lwNNN
	// resizing. Do not transform signed or otherwise unfamiliar query parameters.
	if (url.hostname === 'media.springernature.com' && /^\/lw\d+\/springer-static\/(?:image|esm)\/.+\/MediaObjects\/.+\.(png|jpe?g|webp)$/i.test(url.pathname) &&
		[...url.searchParams].every(([key, value]) => key === 'as' && value === 'webp')) {
		const full = new URL(url.href);
		full.pathname = full.pathname.replace(/^\/lw\d+\//, '/full/');
		return [full.href, url.href];
	}
	return [url.href];
}
