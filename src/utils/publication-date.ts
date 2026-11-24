// Some extractors return a list of ISO dates. A comma inside an English date
// belongs to the date itself ("October 24, 2013").
export function firstPublicationDate(value: string): string {
	return value.split(/,\s*(?=\d{4}-\d{2}-\d{2}\b)/, 1)[0].trim();
}

const months = 'January February March April May June July August September October November December'.split(' ');

export function publicationDay(value: string | null | undefined): string | null {
	const text = value?.trim();
	if (!text) return null;
	const numeric = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text)
		?? /^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日$/.exec(text);
	if (numeric) return calendarDay(numeric[1], Number(numeric[2]), Number(numeric[3]));
	const english = /^([a-z]+)\s+(\d{1,2}),\s*(\d{4})$/i.exec(text);
	if (!english) return null;
	const month = months.findIndex(name => name.toLowerCase() === english[1].toLowerCase()) + 1;
	return calendarDay(english[3], month, Number(english[2]));
}

function calendarDay(year: string, month: number, day: number): string | null {
	const check = new Date(Date.UTC(Number(year), month - 1, day));
	if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
	return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function citationPublicationDay(document: Document, hostname: string): string | null {
	for (const name of ['citation_publication_date', 'citation_date', 'citation_online_date']) {
		for (const tag of Array.from(document.querySelectorAll(`head meta[name="${name}" i]`))) {
			const date = publicationDay(tag.getAttribute('content'));
			if (date) return date;
		}
	}
	if (hostname === 'journals.plos.org') {
		const label = document.getElementById('artPubDate')?.textContent?.trim();
		if (label && /^Published:\s*/i.test(label)) return publicationDay(label.replace(/^Published:\s*/i, ''));
	}
	return null;
}
