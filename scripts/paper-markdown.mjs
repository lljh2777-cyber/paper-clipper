import { fromMarkdown } from 'mdast-util-from-markdown';

export function escapeLiteralLessThan(markdown) {
	if (!markdown.includes('<') || !markdown.includes('>')) return markdown;
	// Marked can mask a comparison such as p<0.05 ... >0.8 as one HTML tag
	// when matching emphasis. Escape only unescaped '<' in CommonMark text nodes.
	const parts = [];
	let cursor = 0;
	function visit(node) {
		if (node.type === 'text') {
			const start = node.position.start.offset;
			const end = node.position.end.offset;
			const raw = markdown.slice(start, end);
			const escaped = raw.replace(/(\\*)</g, (match, slashes) => slashes.length % 2 ? match : `${slashes}&lt;`);
			if (escaped !== raw) {
				parts.push(markdown.slice(cursor, start), escaped);
				cursor = end;
			}
		}
		for (const child of node.children ?? []) visit(child);
	}
	visit(fromMarkdown(markdown));
	parts.push(markdown.slice(cursor));
	return parts.join('');
}
