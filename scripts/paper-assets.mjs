import { lookup as dnsLookup } from 'node:dns';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseFragment } from 'parse5';

export const assetLimits = Object.freeze({ maxImages: 200, maxBytes: 20 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024, timeout: 15000, redirects: 5 });
const types = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp'], ['image/avif', 'avif']]);
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
	['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
	['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) blocked.addSubnet(address, prefix);
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(address, prefix, 'ipv6');

export function isPublicAddress(address) {
	const family = isIP(address);
	return family === 4 ? !blocked.check(address) : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

function imageUrl(value, base) {
	const url = new URL(value, base);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Image URL must use HTTP(S) without credentials.');
	const host = url.hostname.replace(/^\[|\]$/g, '');
	if (isIP(host) && !isPublicAddress(host)) throw new Error('Private or reserved image addresses are not allowed.');
	url.hash = '';
	return url;
}

function publicLookup(hostname, options, callback) {
	dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
		if (error) return callback(error);
		if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) return callback(new Error('Image host resolves to a private or reserved address.'));
		// Supply the checked addresses to the actual socket, with no second DNS lookup.
		if (options.all) callback(null, addresses);
		else callback(null, addresses[0].address, addresses[0].family);
	});
}

export function imageExtension(bytes, contentType) {
	const type = contentType.split(';')[0].trim().toLowerCase();
	const extension = types.get(type);
	const matches = extension === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
		: extension === 'jpg' ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
		: extension === 'gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
		: extension === 'webp' ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
		: extension === 'avif' ? bytes.subarray(4, 8).toString() === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 32).toString('ascii')) : false;
	if (!extension) throw new Error(`Unsupported image Content-Type: ${type || '(missing)'}.`);
	if (!matches) throw new Error('Image bytes do not match the declared image type.');
	return extension;
}

export async function fetchImage(value, { timeout = assetLimits.timeout, maxBytes = assetLimits.maxBytes, lookup = publicLookup } = {}) {
	const signal = AbortSignal.timeout(timeout);
	let url = imageUrl(value);
	for (let redirects = 0; redirects <= assetLimits.redirects; redirects++) {
		const result = await new Promise((resolve, reject) => {
			const request = (url.protocol === 'https:' ? https : http).get(url, {
				signal, lookup, agent: false,
				headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp,image/avif', 'Accept-Encoding': 'identity' },
			}, response => {
				response.on('error', reject);
				const status = response.statusCode;
				if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
					response.destroy();
					resolve({ redirect: response.headers.location });
					return;
				}
				const contentType = response.headers['content-type'] ?? '';
				if (status !== 200 || !types.has(contentType.split(';')[0].trim().toLowerCase()) || Number(response.headers['content-length']) > maxBytes) {
					response.destroy();
					reject(new Error(status !== 200 ? `Image HTTP ${status}.` : Number(response.headers['content-length']) > maxBytes
						? 'Image exceeds the byte limit.' : `Unsupported image Content-Type: ${contentType || '(missing)'}.`));
					return;
				}
				const chunks = [];
				let size = 0;
				response.on('data', chunk => {
					size += chunk.length;
					if (size > maxBytes) {
						response.destroy();
						reject(new Error('Image exceeds the byte limit.'));
					} else chunks.push(chunk);
				});
				response.on('end', () => resolve({ bytes: Buffer.concat(chunks), contentType, finalUrl: url.href }));
			});
			request.on('error', reject);
		});
		if (result.redirect) {
			url = imageUrl(result.redirect, url);
			continue;
		}
		return { ...result, extension: imageExtension(result.bytes, result.contentType) };
	}
	throw new Error('Image exceeded the redirect limit.');
}

export function collectImages(markdown) {
	const frontmatter = markdown.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? '';
	const offset = frontmatter.length;
	const tree = fromMarkdown(markdown.slice(offset));
	const definitions = new Map();
	const images = [];
	const walk = (node, visit) => { visit(node); for (const child of node.children ?? []) walk(child, visit); };
	walk(tree, node => { if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node); });
	walk(tree, node => {
		const start = offset + node.position.start.offset;
		if (node.type === 'image' || node.type === 'imageReference') {
			const definition = node.type === 'image' ? node : definitions.get(node.identifier);
			if (definition) images.push({ format: 'markdown', start, end: offset + node.position.end.offset, url: definition.url, alt: node.alt, title: definition.title });
		} else if (node.type === 'html') {
			const fragment = parseFragment(node.value, { sourceCodeLocationInfo: true });
			const visitHtml = element => {
				if (['pre', 'code', 'script', 'style', 'template', 'textarea'].includes(element.tagName)) return;
				if (element.tagName === 'img') {
					const location = element.sourceCodeLocation;
					const src = element.attrs.find(attr => attr.name === 'src');
					if (src && location?.attrs?.src) {
						const attr = location.attrs.src;
						const srcset = location.attrs.srcset;
						images.push({ format: 'html', url: src.value, start: start + attr.startOffset, end: start + attr.endOffset,
							remove: srcset ? { start: start + srcset.startOffset, end: start + srcset.endOffset } : undefined });
					}
				}
				for (const child of element.childNodes ?? []) visitHtml(child);
			};
			visitHtml(fragment);
		}
	});
	return images.sort((a, b) => a.start - b.start);
}

function markdownImage(image, destination) {
	const alt = (image.alt ?? '').replace(/[\\[\]]/g, '\\$&').replace(/\r?\n/g, ' ');
	const title = image.title ? ` "${image.title.replace(/[\\"]/g, '\\$&').replace(/\r?\n/g, ' ')}"` : '';
	return `![${alt}](<${destination}>${title})`;
}

export async function localizeImages(markdown, { output, url, timeout = assetLimits.timeout }, { download = fetchImage, limits = assetLimits } = {}) {
	const images = collectImages(markdown);
	const report = { requested: true, status: 'complete', occurrences: images.length, downloaded: 0, failed: 0, bytes: 0, items: [] };
	const replacements = [];
	const assets = new Map();
	let directory;
	for (const image of images) {
		let key;
		let error;
		try { key = imageUrl(image.url, url).href; }
		catch (cause) { key = image.url; error = cause.message; }
		let item = assets.get(key);
		if (!item) {
			item = { source: key, status: 'failed', occurrences: 0 };
			assets.set(key, item);
			report.items.push(item);
			try {
				if (error) throw new Error(error);
				if (assets.size > limits.maxImages) throw new Error('Paper exceeds the unique image limit.');
				if (report.bytes >= limits.maxTotalBytes) throw new Error('Paper exceeds the total image byte limit.');
				const result = await download(key, { timeout: Math.min(timeout, limits.timeout), maxBytes: Math.min(limits.maxBytes, limits.maxTotalBytes - report.bytes) });
				const extension = imageExtension(result.bytes, result.contentType);
				if (result.bytes.length > limits.maxBytes || report.bytes + result.bytes.length > limits.maxTotalBytes) throw new Error('Image exceeds the byte limit.');
				if (!directory) {
					// Fresh sibling directories preserve previous attachments during overwrite.
					await mkdir(path.dirname(output), { recursive: true });
					directory = await mkdtemp(path.join(path.dirname(output), `${path.basename(output, path.extname(output)).slice(0, 60)}.assets-`));
					report.directory = directory;
				}
				const file = path.join(directory, `image-${String(report.downloaded + 1).padStart(3, '0')}.${extension}`);
				await writeFile(file, result.bytes, { flag: 'wx' });
				Object.assign(item, { status: 'downloaded', file, relativePath: path.relative(path.dirname(output), file).split(path.sep).map(encodeURIComponent).join('/'),
					finalUrl: result.finalUrl ?? key, contentType: result.contentType, bytes: result.bytes.length });
				report.downloaded++;
				report.bytes += result.bytes.length;
			} catch (cause) {
				item.error = cause.message;
				report.failed++;
			}
		}
		item.occurrences++;
		if (item.status === 'downloaded') {
			replacements.push({ start: image.start, end: image.end, text: image.format === 'html' ? `src="${item.relativePath}"` : markdownImage(image, item.relativePath) });
			if (image.remove) replacements.push({ ...image.remove, text: '' });
		}
	}
	for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
		markdown = markdown.slice(0, replacement.start) + replacement.text + markdown.slice(replacement.end);
	}
	if (report.failed) report.status = 'partial';
	return { markdown, report };
}
