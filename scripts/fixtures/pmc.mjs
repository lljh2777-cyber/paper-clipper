// Public synthetic structure only: no article text or personal archive data.
const prose = 'The synthetic study compares independent measurements across experimental conditions. '.repeat(45);
export const pmcUrl = 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/';
export const pmcHtml = `<!doctype html><html><head><title>Synthetic PMC paper</title>
<meta name="citation_title" content="Synthetic PMC paper"><meta name="citation_author" content="Ada Example">
<meta name="citation_author" content="Ben Sample"><meta name="citation_doi" content="10.1234/synthetic"></head><body><article>
<section aria-label="Article citation and metadata"><section class="pmc-layout__citation">Published in Synthetic Journal.</section>
<section class="front-matter"><div class="ameta p"><hgroup><h1>Synthetic PMC paper</h1></hgroup><div class="cg p">
<a href="/author/ada"><span class="name western">Ada Example</span></a><div hidden><h3>Ada Example</h3>Find articles by Ada Example</div><sup>1</sup>,
<a href="/author/ben"><span class="name western">Ben Sample</span></a><sup>2</sup></div>
<div class="author-notes"><p>Author contributions must remain.</p></div><p>Open access attribution must remain.</p></div></section></section>
<h2>Abstract</h2><p>${prose}</p><h2>Results</h2><p>${prose}Ada Example is also mentioned in the scientific discussion.</p>
<figure class="fig xbox font-sm" id="F1"><h4 class="obj_head">Figure 1. Synthetic experimental workflow.</h4>
<p class="img-box"><img src="https://images.example.org/figure.png" alt="Figure 1."></p>
<div class="p text-right"><a href="figure/F1/">Open in a new tab</a></div>
<figcaption><p>(A) Synthetic workflow.</p><p>(B) Measured log<sub>2</sub> values. See <a href="#SD1">Figure S1</a>.</p></figcaption></figure>
<p>After figure marker.</p><h2>Methods</h2><p>${prose}</p><h2>References</h2><p>Ada Example. Synthetic reference.</p>
<section id="SD1"><h3>Supporting data</h3><p>Supporting information must remain.</p></section></article></body></html>`;
