// 嵌入媒体的真机回归（jsdom 证不了真实解码/播放/Range 取流）：
// 键入 "/file" + Enter → 原生 chooser 选真实音视频文件 → 走真实
// registerAssetRoutes 上传 → 分类成媒体节点 → <video>/<audio> 真实
// 播放（currentTime 前进）→ 页面内 Range 请求拿到 206 → 删除按钮生效。
// 视频夹具由页面内 MediaRecorder 录制 canvas 现场生成（webm，无外部依赖），
// 音频夹具由 Node 直接合成合法 PCM WAV。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const { registerAssetRoutes } = require('../../routes/asset-routes');

/** 合成 440Hz 正弦波 WAV（16bit 单声道 PCM）——Chromium 原生可解码。 */
function makeWav({ seconds = 1, rate = 8000 } = {}) {
    const samples = Math.round(seconds * rate);
    const dataSize = samples * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(rate, 24);
    buffer.writeUInt32LE(rate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < samples; i += 1) {
        const value = Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 12000);
        buffer.writeInt16LE(value, 44 + i * 2);
    }
    return buffer;
}

async function main() {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dumbpad-media-'));
    const app = express();
    const root = path.resolve(__dirname, '../..');
    app.get('/', (_req, res) => res.send(`<!doctype html><html><head>
        <link rel="stylesheet" href="/Assets/styles.css">
        <style>body{margin:0}#editor{height:600px}</style>
        </head><body><div id="editor"></div>
        <script src="/vendor/tiptap/tiptap.bundle.js"></script></body></html>`));
    app.use('/vendor/tiptap', express.static(path.join(root, 'public/vendor/tiptap')));
    app.use(express.static(path.join(root, 'public')));
    registerAssetRoutes(app, {
        storage: { backend: 'local', paths: { DATA_DIR: dataDir }, getS3Prefix: () => '' },
        originValidationMiddleware: (_req, _res, next) => next(),
    });

    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => {
        // 环境噪音豁免：本地字体文件不入库（AGENTS.md：不碰图标与图片资源），
        // 最小测试页也没有 favicon。Chrome 的资源错误 console 文本不含 URL，
        // 要查 location().url。
        const url = msg.location()?.url || '';
        const benign = url.includes('/font/') || url.includes('/favicon.ico');
        if (msg.type() === 'error' && !benign) errors.push(`console: ${msg.text()} @ ${url}`);
    });
    page.on('response', response => {
        // 本地字体文件不入库（AGENTS.md：不碰图标与图片资源），测试页 404 属环境噪音。
        if (response.status() >= 400 && !(/\/font\//.test(response.url()) || /\/favicon\.ico$/.test(response.url()))) {
            errors.push(`http ${response.status()}: ${response.url()}`);
        }
    });

    const failures = [];
    const check = (name, ok, detail) => {
        if (ok) console.log(`PASS ${name}`);
        else {
            failures.push(name);
            console.error(`FAIL ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
        }
    };

    const fixturesDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dumbpad-media-fixtures-'));
    const focusEditorEnd = async () => {
        // headless 下 focus('end') 偶发没把 DOM 焦点交回编辑器（keydown 派发
        // 到 body，编辑器监听收不到）：聚焦后必须断言 activeElement，失败重试。
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await page.evaluate(() => editor.editor.commands.focus('end'));
            const focused = await page.evaluate(() => document.activeElement === editor.editor.view.dom);
            if (focused) return;
            await page.waitForTimeout(120);
        }
        throw new Error('editor did not take DOM focus');
    };

    const cleanupStrayCommand = async () => {
        // 重试清理必须走 PM 事务定点删除：裸 Backspace 会选中并吞掉前面的
        // 媒体原子节点（真实踩过：视频节点被清理退格吃掉）。同时处理 Enter
        // 落进斜杠菜单时可能误触 /time 留下的时间标记。
        await page.evaluate(() => {
            const view = editor.editor.view;
            const state = view.state;
            const removals = [];
            state.doc.descendants((node, pos) => {
                if (node.type.name === 'timeMarker') {
                    removals.push({ from: pos, to: pos + node.nodeSize });
                } else if (node.isText && node.text?.includes('/file')) {
                    const idx = node.text.lastIndexOf('/file');
                    removals.push({ from: pos + idx, to: pos + idx + '/file'.length });
                }
                return true;
            });
            if (!removals.length) return;
            const tr = state.tr;
            removals.reverse().forEach(({ from, to }) => tr.delete(from, to));
            view.dispatch(tr);
        });
    };

    const uploadViaFileCommand = async (filePath, { useClick = false } = {}) => {
        // 首次用真实 click 聚焦（headless 首次 type 偶发丢失）；后续点击中心会
        // 落在媒体卡片上、焦点被原生控件吃掉，改为确定性的文末聚焦。
        if (useClick) {
            await page.click('#editor .tiptap');
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (!useClick) await focusEditorEnd();
            await page.keyboard.type('/file');
            const chooserPromise = page.waitForEvent('filechooser', { timeout: 4000 });
            await page.keyboard.press('Enter');
            try {
                const chooser = await chooserPromise;
                await chooser.setFiles(filePath);
            } catch {
                // headless 时序抖动（slash-menu 回归注释里同类现象）：斜杠菜单
                // 尚未就绪时 Enter 可能落空。定点清理残留命令文本后整轮重试。
                await page.keyboard.press('Escape');
                await cleanupStrayCommand();
                await page.waitForTimeout(150);
                continue;
            }
            await page.waitForSelector('.dumbpad-article-media', { timeout: 15000 });
            await page.waitForTimeout(150);
            return;
        }
        throw new Error('file chooser never opened after retries');
    };

    try {
        await page.goto(baseUrl);
        await page.bringToFront();
        await page.evaluate(async () => {
            const { HybridMarkdownEditor } = await import('/tiptap-editor.js');
            window.editor = new HybridMarkdownEditor(document.querySelector('#editor'));
            await editor.whenReady();
        });
        await page.click('#editor .tiptap');
        await page.waitForTimeout(200);

        // ---- 视频夹具：页面内 MediaRecorder 录 canvas → webm ----
        await page.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 64;
            // canvas 必须在 DOM 里才会有合成帧（脱节 canvas 的 captureStream
            // 产出 0 字节）；移到视口外避免闪动。
            canvas.style.cssText = 'position:absolute;left:-9999px;top:0;';
            document.body.appendChild(canvas);
            const ctx = canvas.getContext('2d');
            const stream = canvas.captureStream(10);
            const chunks = [];
            const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
            recorder.ondataavailable = event => { if (event.data && event.data.size) chunks.push(event.data); };
            recorder.start(100);
            let frame = 0;
            const timer = setInterval(() => {
                ctx.fillStyle = `hsl(${(frame * 36) % 360},80%,50%)`;
                ctx.fillRect(0, 0, 64, 64);
                frame += 1;
            }, 100);
            await new Promise(resolve => setTimeout(resolve, 1500));
            clearInterval(timer);
            recorder.stop();
            await new Promise(resolve => { recorder.onstop = resolve; });
            canvas.remove();
            window.videoBlob = new Blob(chunks, { type: 'video/webm' });
        });
        const videoBytes = await page.evaluate(async () => Array.from(new Uint8Array(await window.videoBlob.arrayBuffer())));
        const videoPath = path.join(fixturesDir, '录屏.webm');
        await fs.promises.writeFile(videoPath, Buffer.from(videoBytes));
        check('video fixture is a non-empty webm', videoBytes.length > 1000, videoBytes.length);

        // ---- /file → 视频上传 → 媒体节点 ----
        await uploadViaFileCommand(videoPath, { useClick: true });
        check('video file renders as a media player card', await page.$eval(
            '.dumbpad-article-media',
            el => el.dataset.mediaKind === 'video' && Boolean(el.querySelector('video[controls]')),
        ));
        const videoSrc = await page.$eval('.dumbpad-article-media video', el => el.getAttribute('src'));
        check('video src points at the asset original variant', /\/api\/assets\/[a-f0-9-]{16,64}\/original/.test(videoSrc || ''), videoSrc);
        check('value carries the dumbpad-video metadata', (await page.evaluate(() => editor.getValue())).includes('"dumbpad-video=1;'));
        check('meta row shows the file name', await page.$eval(
            '.dumbpad-article-media-name',
            el => el.textContent.startsWith('录屏.webm'),
        ), await page.$eval('.dumbpad-article-media-name', el => el.textContent));

        // ---- 真实播放：readyState 达到可解码、currentTime 前进 ----
        const playback = await page.evaluate(async (selector) => {
            const media = document.querySelector(selector);
            media.muted = true; // headless 自动播放策略：静音不影响「取流+解码+播放」的证明
            try {
                await media.play();
            } catch (error) {
                return { error: error.message };
            }
            await new Promise(resolve => setTimeout(resolve, 600));
            return { readyState: media.readyState, currentTime: media.currentTime, paused: media.paused };
        }, '.dumbpad-article-media video');
        check('video actually plays (decoded stream advances)', !playback.error
            && playback.readyState >= 2 && playback.currentTime > 0, playback);

        // ---- 页面内 Range 请求：媒体资产必须 206 分段 ----
        const rangeProbe = await page.evaluate(async (src) => {
            const response = await fetch(src, { headers: { Range: 'bytes=0-31' } });
            const body = await response.arrayBuffer();
            return {
                status: response.status,
                acceptRanges: response.headers.get('accept-ranges'),
                contentRange: response.headers.get('content-range'),
                bytes: body.byteLength,
            };
        }, videoSrc);
        check('page-side Range request gets 206 partial content', rangeProbe.status === 206
            && rangeProbe.acceptRanges === 'bytes' && rangeProbe.bytes === 32, rangeProbe);

        // ---- /file → 音频上传 → 播放 ----
        const audioPath = path.join(fixturesDir, '录音.wav');
        await fs.promises.writeFile(audioPath, makeWav({ seconds: 1 }));
        await uploadViaFileCommand(audioPath);
        check('audio file renders as a media card with meta above the player', await page.$eval(
            '.dumbpad-article-media[data-media-kind="audio"]',
            el => el.dataset.mediaKind === 'audio'
                && el.firstElementChild.classList.contains('dumbpad-article-media-meta')
                && Boolean(el.querySelector('audio[controls]')),
        ));
        check('value carries the dumbpad-audio metadata', (await page.evaluate(() => editor.getValue())).includes('"dumbpad-audio=1;'));
        const audioPlayback = await page.evaluate(async () => {
            const media = document.querySelector('.dumbpad-article-media audio');
            media.muted = true;
            try {
                await media.play();
            } catch (error) {
                return { error: error.message };
            }
            await new Promise(resolve => setTimeout(resolve, 600));
            return { readyState: media.readyState, currentTime: media.currentTime, paused: media.paused };
        });
        check('audio actually plays', !audioPlayback.error
            && audioPlayback.readyState >= 2 && audioPlayback.currentTime > 0, audioPlayback);

        // ---- 服务端真实存储：/api/assets 列表里出现两个 file 资产 ----
        const listing = await page.evaluate(async () => {
            const response = await fetch('/api/assets?kind=file');
            return response.json();
        });
        check('uploaded media are listed as file assets', listing.assets.length === 2
            && listing.assets.every(asset => asset.kind === 'file'), listing);

        // ---- 删除按钮真实生效（明确点视频卡片的删除） ----
        await page.click('.dumbpad-article-media[data-media-kind="video"] .dumbpad-article-media-delete');
        await page.waitForTimeout(250);
        check('delete button removes the video card', await page.$$eval('.dumbpad-article-media', els => els.length) === 1
            && await page.$eval('.dumbpad-article-media', el => el.dataset.mediaKind) === 'audio');
        const valueAfterDelete = await page.evaluate(() => editor.getValue());
        check('video markdown removed while audio stays intact', !valueAfterDelete.includes('"dumbpad-video=1;')
            && valueAfterDelete.includes('"dumbpad-audio=1;'), valueAfterDelete);

        check('no page errors', errors.length === 0, errors);
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        await fs.promises.rm(dataDir, { recursive: true, force: true });
        await fs.promises.rm(fixturesDir, { recursive: true, force: true });
    }

    console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nMedia embed browser checks passed');
    if (failures.length) process.exitCode = 1;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
