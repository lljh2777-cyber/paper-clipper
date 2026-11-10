// Public synthetic content only: punctuation boundaries and responsive images.
export const natureFiguresUrl = 'https://www.nature.com/articles/synthetic-figures';
export const natureFigureImage = 'https://images.example.org/figure-6.webp';
export const natureExtendedImage = 'https://media.springernature.com/lw685/springer-static/esm/art%3Asynthetic/MediaObjects/extended-1.jpg';
const prose = 'This synthetic experiment compares independent measurements across groups and describes the method. '.repeat(40);
export const natureFiguresHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic figure study</title>
<meta name="citation_doi" content="10.1234/synthetic-figures"><meta name="citation_publication_date" content="2026-11-10"></head><body><article>
<h1>Synthetic figure study</h1><h2>Results</h2><p>${prose}See Fig. <a href="#Fig6">6b</a> and Extended Data Fig. <a href="#Fig7">1a</a>.</p>
<figure><figcaption><b id="Fig6">Fig. 6: Synthetic group comparison.</b></figcaption><div class="c-article-section__figure-content">
<picture><source type="image/webp" srcset="${natureFigureImage} 685w, https://images.example.org/figure-6-large.webp 1200w">
<img src="https://images.example.org/figure-6.jpg" width="685" height="400" alt="Fig. 6"></picture>
<div id="figure-6-desc" class="c-article-section__figure-description">
<p><b>a</b>, Measured <i>ALPHA</i> <i>n</i> = 22, <i>BETA</i> <i>n</i> = 7<i>, GAMMA</i> <i>n</i> = 9 or <i>DELTA</i> <i>n</i> = 11.</p>
<p><b>b</b>, Independent groups compared at <i>P</i> &lt; 0.05; <em>x</em> = 3<em>; y</em> = 4.</p>
</div></div></figure><h2>Methods</h2><p>${prose}</p>
<h2>Extended data figures and tables</h2><div class="c-article-supplementary__item" id="Fig7"><h3>
<a href="/articles/synthetic-figures/figures/7" data-supp-info-image="${natureExtendedImage}">Extended Data Fig. 1 Synthetic validation.</a></h3>
<div class="c-article-supplementary__description"><p><b>a</b>, Independent validation sample.</p></div></div>
</article></body></html>`;
