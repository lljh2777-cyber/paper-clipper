import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditLocalizedMarkdown } from './accept-assets.mjs';
import { localizeImages } from './paper-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDXsAAAAASUVORK5CYII=', 'base64');

test('asset audit accepts valid localization but catches prose, count, destination, label and attachment changes', async () => {
	await mkdir(path.join(root, 'output/browser-fetch/tests'), { recursive: true });
	const directory = await mkdtemp(path.join(root, 'output/browser-fetch/tests/asset-audit-'));
	const options = { url: 'https://publisher.example/article', output: path.join(directory, 'paper.md') };
	const original = 'Original text with $x_i$.\n\n![Figure](https://images.example/figure.png "title")';
	const result = await localizeImages(original, options, { download: async () => ({ bytes: png, contentType: 'image/png' }) });
	const audit = (markdown = result.markdown, report = result.report) => auditLocalizedMarkdown(original, markdown, report, options.output, options.url);
	assert.equal((await audit()).passed, true);
	for (const changed of [result.markdown.replace('Original', 'Changed'), result.markdown + '\n' + result.markdown,
		result.markdown.replace(result.report.items[0].relativePath, 'missing.png'), result.markdown.replace('Figure', 'Lost label')]) {
		assert.equal((await audit(changed)).passed, false);
	}
	const corruptReport = structuredClone(result.report);
	corruptReport.items[0].bytes++;
	assert.equal((await audit(result.markdown, corruptReport)).passed, false);
	corruptReport.items[0].relativePath = '../outside.png';
	assert.equal((await audit(result.markdown, corruptReport)).passed, false);
});
