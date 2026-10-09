import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { FileText } from 'lucide';
import { parseHTML } from 'linkedom';

// Render the installed Lucide FileText icon; no upstream brand artwork is used.
const { document } = parseHTML('<html></html>');
function element([tag, attributes, children = []]) {
	const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
	for (const child of children) node.appendChild(element(child));
	return node;
}
const icon = element(['svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 128 128', width: 128, height: 128 }, [
	['rect', { x: 4, y: 4, width: 120, height: 120, rx: 24, fill: '#137b72' }],
	['svg', { ...FileText[1], x: 25, y: 21, width: 78, height: 86, stroke: '#ffffff', 'stroke-width': 1.8 }, FileText[2]],
]]).outerHTML;
const output = name => fileURLToPath(new URL(`../src/icons/${name}`, import.meta.url));
await writeFile(output('paper-clipper.svg'), `${icon}\n`);
const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage({ deviceScaleFactor: 1 });
	for (const size of [16, 48, 128]) {
		await page.setViewportSize({ width: size, height: size });
		await page.setContent(`<style>html,body{margin:0;background:transparent}body>svg{display:block;width:100%;height:100%}</style>${icon}`);
		await page.screenshot({ path: output(`icon${size}.png`), omitBackground: true });
	}
} finally {
	await browser.close();
}
console.log('Rendered Paper Clipper icons (16, 48, 128).');
