// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { collectFigureLinks } from './figure-links';

it('maps explicit Nature and Cell figure IDs without mutating the snapshot', () => {
	document.body.innerHTML = '<figure><figcaption id="Fig1">Fig. 1</figcaption><img src="/one.png"></figure><figure id="fig2"><img src="/two.png"></figure>';
	const before = document.body.innerHTML;
	expect(collectFigureLinks(document, 'https://example.org/paper')).toEqual({
		'https://example.org/paper#Fig1': 'https://example.org/one.png',
		'https://example.org/paper#fig2': 'https://example.org/two.png',
	});
	expect(document.body.innerHTML).toBe(before);
});

it('does not guess multi-image figures or ambiguous duplicate IDs', () => {
	document.body.innerHTML = '<figure id="Fig1"><img src="/a.png"><img src="/b.png"></figure><figure id="Fig2"><img src="/a.png"></figure><figure id="Fig2"><img src="/b.png"></figure>';
	expect(collectFigureLinks(document, 'https://example.org/paper')).toEqual({});
});
