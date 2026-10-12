import Defuddle, { createMarkdownContent } from 'defuddle/full';
import { assertMathPreserved } from './paper-math.mjs';
import { setElementHTML } from './dom-utils';
import { prepareDocumentForExtraction } from './publisher-figures';

// Parse document content for clipping. In reader mode, extracts from
// the article's original HTML to avoid reader UI artifacts.
export function parseForClip(doc: Document) {
	const readerArticle = doc.querySelector('.obsidian-reader-active .obsidian-reader-content article');
	if (readerArticle) {
		const readerDoc = doc.implementation.createHTMLDocument();
		const originalHtml = readerArticle.getAttribute('data-original-html');
		if (originalHtml) {
			setElementHTML(readerDoc.body, originalHtml);
		} else {
			readerDoc.body.replaceChildren(
				...Array.from(readerArticle.childNodes).map(n => readerDoc.importNode(n, true))
			);
		}
		const result = new Defuddle(prepareDocumentForExtraction(readerDoc, doc.URL), { url: '' }).parse();
		assertMathPreserved(readerDoc, createMarkdownContent(result.content, doc.URL));
		return result;
	}
	const result = new Defuddle(prepareDocumentForExtraction(doc, doc.URL), { url: doc.URL }).parse();
	assertMathPreserved(doc, createMarkdownContent(result.content, doc.URL));
	return result;
}
