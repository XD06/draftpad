/**
 * 引用块视觉回归（真实浏览器）。形态：一条带圆角的细竖线 + 比正文浅一档的正体字，
 * 不画卡片、不加引号装饰（用户明确否掉了实心卡片）。竖线由 ::before 伪元素画，
 * 不进 DOM，所以 PM 的解析与存储完全不受影响。
 *
 * 必须钉住的三件事：正体（不是全局 blockquote 的 italic）、颜色确实比正文浅、
 * 块内最后一段不再有 margin-bottom（否则文字下面多出一条空隙 = 用户报的「多余空白」）。
 * jsdom 的 getComputedStyle 不解析级联与伪元素，这些断言放 jsdom 里等于没测。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

module.exports = async function testBlockquoteStyle(browser) {
    const app = express();
    const root = path.resolve(__dirname, '../..');
    app.get('/', (_req, res) => res.send(`<!doctype html><html><head><meta charset="utf-8">
        <link rel="stylesheet" href="/Assets/styles.css">
        <link rel="stylesheet" href="/Assets/ios-theme.css">
        <style>body{margin:0}#editor{height:700px}</style>
        </head><body><div class="typora-editor-shell"><div id="editor"></div></div>
        <script src="/vendor/tiptap/tiptap.bundle.js"></script></body></html>`));
    app.use('/vendor/tiptap', express.static(path.join(root, 'public/vendor/tiptap')));
    app.use(express.static(path.join(root, 'public')));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const errors = [];
    const measure = async (viewport, markdown) => {
        const page = await browser.newPage({ viewport });
        page.on('pageerror', error => errors.push(error.message));
        try {
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            return await page.evaluate(async (value) => {
                const { HybridMarkdownEditor } = await import('/tiptap-editor.js');
                const editor = new HybridMarkdownEditor(document.querySelector('#editor'));
                await editor.whenReady();
                editor.setValue(value, false);
                await new Promise(resolve => setTimeout(resolve, 600));
                const outside = document.querySelector('.tiptap > p');
                const quotes = [...document.querySelectorAll('.tiptap blockquote')].map((el) => {
                    const cs = getComputedStyle(el);
                    const bar = getComputedStyle(el, '::before');
                    const rect = el.getBoundingClientRect();
                    const last = el.lastElementChild.getBoundingClientRect();
                    return {
                        text: el.textContent,
                        fontStyle: cs.fontStyle,
                        background: cs.backgroundColor,
                        borderLeft: `${cs.borderLeftWidth} ${cs.borderLeftStyle}`,
                        paddingLeft: cs.paddingLeft,
                        color: cs.color,
                        barContent: bar.content,
                        barWidth: bar.width,
                        barRadius: bar.borderRadius,
                        barBackground: bar.backgroundColor,
                        barLeft: bar.left,
                        barTop: bar.top,
                        barBottom: bar.bottom,
                        boxHeight: Math.round(rect.height),
                        lineHeightGap: Math.round(rect.bottom - last.bottom),
                        lastChildMarginBottom: getComputedStyle(el.lastElementChild).marginBottom,
                        childCount: el.children.length,
                    };
                });
                return { innerWidth: window.innerWidth, outsideColor: getComputedStyle(outside).color, quotes };
            }, markdown);
        } finally {
            await page.close();
        }
    };

    // `color(srgb .44 .44 .46)` 与 `rgb(118, 118, 128, .2)` 两种形态都要能读
    const toRgb = (value) => {
        const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(value);
        if (srgb) return srgb.slice(1, 4).map(part => Math.round(Number(part) * 255));
        const rgb = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)/.exec(value);
        if (rgb) return rgb.slice(1, 4).map(Number);
        return null;
    };
    const luminance = (value) => {
        const rgb = toRgb(value);
        assert.ok(rgb, `unparsable color: ${value}`);
        return (rgb[0] + rgb[1] + rgb[2]) / 3;
    };

    try {
        for (const [label, viewport, padding] of [
            ['desktop', { width: 1280, height: 900 }, '26px'],
            ['narrow', { width: 420, height: 900 }, '22px'],
        ]) {
            const single = await measure(viewport, '> 单行引用');
            const quote = single.quotes[0];
            assert.equal(quote.fontStyle, 'normal', `${label}: quote text must be upright, not italic`);
            assert.equal(quote.background, 'rgba(0, 0, 0, 0)',
                `${label}: no card fill allowed: ${JSON.stringify(quote)}`);
            assert.equal(quote.borderLeft, '0px none',
                `${label}: the border must be gone, the bar is a pseudo element: ${JSON.stringify(quote)}`);
            assert.equal(quote.paddingLeft, padding, `${label}: gap between bar and text`);
            assert.equal(quote.barContent, '""', `${label}: ::before must be an empty box, not a glyph`);
            assert.equal(quote.barWidth, '3px', `${label}: bar width: ${JSON.stringify(quote)}`);
            assert.equal(quote.barRadius, '3px', `${label}: the bar must be rounded`);
            assert.equal(quote.barLeft, '0px', `${label}: the bar sits on the left edge`);
            assert.ok(toRgb(quote.barBackground) && /(rgba\()|(\/ *0?\.\d+)/.test(quote.barBackground),
                `${label}: the bar must be a translucent grey, got ${quote.barBackground}`);
            assert.ok(luminance(quote.color) > luminance(single.outsideColor) + 20,
                `${label}: the quote text must read lighter than body text: `
                + `${quote.color} vs ${single.outsideColor}`);
            assert.equal(quote.lastChildMarginBottom, '0px',
                `${label}: inner paragraphs must not keep a bottom margin`);
            assert.equal(quote.lineHeightGap, 0,
                `${label}: nothing may dangle below the last line, got ${quote.lineHeightGap}px`);

            const stacked = await measure(viewport, '> 甲\n>\n> 乙');
            assert.equal(stacked.quotes[0].childCount, 2, `${label}: legacy quote keeps two paragraphs`);
            assert.equal(stacked.quotes[0].lastChildMarginBottom, '0px',
                `${label}: the last line must not add a trailing gap`);
            assert.equal(stacked.quotes[0].lineHeightGap, 0,
                `${label}: no phantom gap under the last line, got ${stacked.quotes[0].lineHeightGap}px`);
            assert.ok(stacked.quotes[0].boxHeight > 40,
                `${label}: two lines must be taller than one: ${stacked.quotes[0].boxHeight}`);
        }

        assert.deepEqual(errors, []);
        console.log('Blockquote style browser regression passed');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
};

if (require.main === module) {
    (async () => {
        const { chromium } = require(process.env.DUMBPAD_PLAYWRIGHT_MODULE || 'playwright');
        const browser = await chromium.launch({ channel: 'chrome', headless: true });
        try { await module.exports(browser); } finally { await browser.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
}
