// Public, synthetic CHTML examples. No publisher text or captured article data.
export const token = (text, type = 'mi', font = '') => `<mjx-${type}${font ? ` data-semantic-font="${font}"` : ''}><mjx-c>${text}</mjx-c></mjx-${type}>`;
export const sub = (base, index) => `<mjx-msub>${base}<mjx-script>${index}</mjx-script></mjx-msub>`;
export const container = (body, block = false) => `${block ? '<div class="display-formula">' : ''}<mjx-container jax="CHTML" class="MathJax"><mjx-math class="MM-N" aria-hidden="true">${body}</mjx-math></mjx-container>${block ? '</div>' : ''}`;
const cell = body => `<mjx-mtd>${body}<mjx-tstrut></mjx-tstrut></mjx-mtd>`;
const row = cells => `<mjx-mtr>${cells}</mjx-mtr>`;
const table = rows => `<mjx-mtable><mjx-table><mjx-itable>${rows}</mjx-itable></mjx-table></mjx-mtable>`;
const space = '<mjx-mspace style="width: 0.5em;"></mjx-mspace>';
const a = n => sub(token('a'), token(String(n), 'mn'));
export const spacedMatrix = token('A') + token('=', 'mo') + token('[', 'mo') + table(
	row(cell(a(11) + sub(`<mjx-mrow>${space}${token('a')}</mjx-mrow>`, token('12', 'mn')) + space + sub(token('t'), token('x')))) +
	row(cell(a(21) + space + a(22) + space + sub(token('t'), token('y'))))) + token(']', 'mo');
export const gridMatrix = token('[', 'mo') + table(row(cell(token('a')) + cell(token('b')) + cell(token('c'))) + row(cell(token('d')) + cell(token('e')) + cell(token('f')))) + token(']', 'mo');
export const fraction = '<mjx-mfrac><mjx-frac><mjx-num><mjx-nstrut></mjx-nstrut>' + token('1', 'mn') + '</mjx-num><mjx-dbox><mjx-dtable><mjx-line></mjx-line><mjx-row><mjx-den><mjx-dstrut></mjx-dstrut>' + sub(token('q'), sub(token('c'), token('i'))) + '</mjx-den></mjx-row></mjx-dtable></mjx-dbox></mjx-frac></mjx-mfrac>';
export const sum = '<mjx-munderover>' + token('\u2211', 'mo') + '<mjx-script>' + token('K') + '<mjx-spacer></mjx-spacer><mjx-mrow>' + token('i') + token('=', 'mo') + token('1', 'mn') + '</mjx-mrow></mjx-script></mjx-munderover>';
export const paragraph = 'The synthetic experiment compares independent measurements and describes reproducible methods. '.repeat(70);
export const mathHtml = `<!doctype html><html><head><title>Synthetic math preservation</title></head><body><article><h1>Synthetic math preservation</h1>
<h2>Results</h2><p>${paragraph}</p><div role="paragraph">The coordinate ${container(sub(token('x', 'mi', 'bold-italic'), token('i')))} is in ${container(token('\u211d', 'mi', 'normal'))}.
The spaced matrix is:${container(spacedMatrix, true)}The grid is:${container(gridMatrix, true)}The weight ${container(fraction)} and sum ${container(sum)} are retained.</div>
<h2>Methods</h2><p>${paragraph}</p><p>Repeated measurement ${container(token('z'))} and ${container(token('z'))}.</p></article></body></html>`;
