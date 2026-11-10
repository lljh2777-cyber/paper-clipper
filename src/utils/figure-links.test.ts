// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { collectFigureLinks } from './figure-links';

it('maps explicit Nature and Cell figure IDs without mutating the snapshot', () => {
	document.body.innerHTML = '<figure><figcaption id="Fig1">Fig. 1</figcaption><img src="/one.png"></figure><figure id="fig2"><img src="/two.png"></figure>';
	const before = document.body.innerHTML;
	expect(collectFigureLinks(document, 'https://example.org/paper', '![a](/one.png)\n![b](/two.png)')).toEqual({
		'https://example.org/paper#Fig1': 'https://example.org/one.png',
		'https://example.org/paper#fig2': 'https://example.org/two.png',
	});
	expect(document.body.innerHTML).toBe(before);
});

it('does not guess multi-image figures or ambiguous duplicate IDs', () => {
	document.body.innerHTML = '<figure id="Fig1"><img src="/a.png"><img src="/b.png"></figure><figure id="Fig2"><img src="/a.png"></figure><figure id="Fig2"><img src="/b.png"></figure>';
	expect(collectFigureLinks(document, 'https://example.org/paper', '![a](/a.png)\n![b](/b.png)')).toEqual({});
});

it('matches declared responsive variants to actual Markdown images, including reference images and comma URLs', () => {
	document.body.innerHTML = '<figure id="Fig6"><picture><source srcset="/small.webp 1x,/large.webp?crop=1,2 2x"><img src="/fallback.jpg"></picture></figure>';
	expect(collectFigureLinks(document, 'https://example.org/paper', '![Figure][img]\n\n[img]: /large.webp?crop=1,2')).toEqual({
		'https://example.org/paper#Fig6': 'https://example.org/large.webp?crop=1,2',
	});
	// A template can omit the image or insert multiple variants. Neither case
	// provides a unique local destination; text/code/frontmatter are not images.
	for (const md of ['![a](/small.webp)\n![b](/fallback.jpg)', '`![a](/fallback.jpg)`',
		'---\nimage: ![a](/fallback.jpg)\n---\n[image](/fallback.jpg)', '![changed](/unrelated.png)']) {
		expect(collectFigureLinks(document, 'https://example.org/paper', md)).toEqual({});
	}
	document.body.insertAdjacentHTML('beforeend', '<div id="Fig6">Other target</div>');
	expect(collectFigureLinks(document, 'https://example.org/paper', '![a](/small.webp)')).toEqual({});
});

it('supports lazy image candidates but does not interpret unrelated attributes as images', () => {
	document.body.innerHTML = '<figure id="Fig1"><img data-src="/one.png" data-srcset="/two.png 200w, /three.png 400w" data-other="/four.png"></figure>';
	for (const file of ['one', 'two', 'three']) expect(collectFigureLinks(document, 'https://example.org/paper', `![a](/${file}.png)`)).toEqual({
		'https://example.org/paper#Fig1': `https://example.org/${file}.png`,
	});
	expect(collectFigureLinks(document, 'https://example.org/paper', '![a](/four.png)')).toEqual({});
});
