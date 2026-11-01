// 从用户源图（public/Assets/dumbpad-512.png，实际 608x558 非方形）派生
// 尺寸声明真实的 PWA 图标：192/512 "any" 方形画布 + 512 "maskable"（安卓
// 桌面蒙版裁切安全区）。源图只读不改，产物可随时重跑覆盖。
// 用法：node scripts/generate-maskable-icon.js
const path = require("path");
const sharp = require("sharp");

const ASSETS_DIR = path.join(__dirname, "..", "public", "Assets");
const SOURCE_ICON = path.join(ASSETS_DIR, "dumbpad-512.png");
// maskable 安全区：关键内容须落在画布中央 80% 的圆内（任意蒙版下可见）。
const SAFE_ZONE_RATIO = 0.8;
const CONTAIN_BG = { r: 0, g: 0, b: 0, alpha: 0 };
// maskable 底色必须与 manifest 的 background_color、ios-theme.css 的
// --bg-color 完全一致。Edge 的启动屏把图标按正方形原样画出（不套蒙版），
// 底色只要差一级就会在启动屏上显出一块砖：实测取源图不透明均色是
// rgb(217,216,212)，与 #f2f2f7 差 25 级，启动屏上肉眼非常明显。
const MASKABLE_BACKGROUND = "#f2f2f7";
// 图标是渐变+噪点的照片质感图，调色板量化能把 192 从 48KB 压到 ~14KB、
// 512 从 248KB 压到 ~70KB，观感无可见损失（256 色足够这张图）。
const ICON_PNG = { palette: true, quality: 88, compressionLevel: 9 };

function hexToRgb(hex) {
    const value = parseInt(hex.replace("#", ""), 16);
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

async function main() {
    const source = sharp(SOURCE_ICON);
    const background = hexToRgb(MASKABLE_BACKGROUND);

    // "any" 用途：等比收进正方形画布、透明填充。只修正尺寸声明，不改变观感。
    for (const size of [192, 512]) {
        await source.clone()
            .resize(size, size, { fit: "contain", background: CONTAIN_BG })
            .png(ICON_PNG)
            .toFile(path.join(ASSETS_DIR, `dumbpad-icon-${size}.png`));
    }

    // maskable：内容缩进 80% 安全区，底色铺满整张画布。
    const inner = Math.round(512 * SAFE_ZONE_RATIO);
    const content = await source.clone()
        .resize(inner, inner, { fit: "contain", background: CONTAIN_BG })
        .png()
        .toBuffer();
    await sharp({
        create: { width: 512, height: 512, channels: 4, background: { ...background, alpha: 1 } }
    })
        .composite([{ input: content, gravity: "center" }])
        .png(ICON_PNG)
        .toFile(path.join(ASSETS_DIR, "dumbpad-maskable-512.png"));

    console.log(`Generated dumbpad-icon-192.png, dumbpad-icon-512.png, dumbpad-maskable-512.png (maskable background ${MASKABLE_BACKGROUND})`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
