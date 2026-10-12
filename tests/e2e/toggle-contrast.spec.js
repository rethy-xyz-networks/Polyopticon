'use strict';

// A pressed toggle button (.on) must be clearly different from an unpressed one, in both
// themes: a visible fill against the toolbar, readable text on that fill, and an accent underline.

const { test, expect } = require('./fixtures');

// WCAG relative luminance and contrast ratio, from an rgb()/rgba() string blended over a backdrop.
const lum = ([r, g, b]) => {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

async function colours(window) {
  return window.evaluate(() => {
    // rgb(255, 0, 0) / rgba(…), or color(srgb 1 0 0 / .5) for color-mix() — channels 0–1 there.
    const parse = s => { const n = (s.match(/[\d.]+/g) || []).map(Number); return s.startsWith('color(') ? n.map((v, i) => (i < 3 ? v * 255 : v)) : n; };
    // Paint the button's own (possibly translucent) colour over its toolbar's opaque background.
    const opaqueBg = el => { for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.length === 3 || c[3] === 1) return c.slice(0, 3); } return [0, 0, 0]; };
    const over = (c, base) => { const a = c.length === 4 ? c[3] : 1; return base.map((v, i) => c[i] * a + v * (1 - a)); };
    const b = document.querySelector('#btn-group');
    b.style.transition = 'none';                                   // read the end state, not mid-fade
    const base = opaqueBg(b.parentElement);
    const read = () => { const cs = getComputedStyle(b); return { bg: over(parse(cs.backgroundColor), base), fg: parse(cs.color).slice(0, 3), underline: cs.boxShadow }; };
    b.classList.remove('on'); const off = read();
    b.classList.add('on');    const on = read();
    return { base, off, on };
  });
}

for (const dark of [true, false]) {
  test(`a pressed toggle stands out clearly (${dark ? 'dark' : 'light'} theme)`, async ({ window }, info) => {
    await window.evaluate(d => { document.documentElement.dataset.theme = d ? 'dark' : 'light'; }, dark);
    await window.mouse.move(0, 0);                                   // no hover
    const { base, off, on } = await colours(window);
    expect(ratio(on.bg, base), 'pressed fill vs toolbar').toBeGreaterThan(1.3);   // the old 16% tint: ~1.15 dark, ~1.26 light
    expect(ratio(on.fg, on.bg), 'pressed text on its fill').toBeGreaterThan(4.5);
    expect(on.underline, 'pressed: accent underline').toMatch(/inset/);
    expect(off.underline, 'unpressed: no underline').toBe('none');
    await window.evaluate(() => { document.querySelector('#btn-autoscroll').classList.add('on'); document.querySelector('#btn-group').classList.add('on'); });
    await window.locator('#btn-group').locator('..').screenshot({ path: info.outputPath(`toolbar-${dark ? 'dark' : 'light'}.png`) });
  });
}
