// 从用户源图（public/Assets/dumbpad-512.png，实际 608x558 非方形）派生
// 尺寸声明真实的 PWA 图标：192/512 "any" 方形画布 + 512 "maskable"（安卓
// 桌面圆形裁切安全区）。源图只读不改，产物可随时重跑覆盖。
// 用法：node scripts/generate-maskable-icon.js
const path = require("path");
const sharp = require("sharp");

const ASSETS_DIR = path.join(__dirname, "..", "public", "Assets");
const SOURCE_ICON = path.join(ASSETS_DIR, "dumbpad-512.png");
// maskable 安全区：关键内容须落在画布中央 80% 的圆内（任意蒙版下可见）。
const SAFE_ZONE_RATIO = 0.8;
const CONTAIN_BG = { r: 0, g: 0, b: 0, alpha: 0 };

// 取全图不透明像素的均色作为 maskable 底色：图标主体是纸面白，源图将来
// 重导出后底色仍会自动跟随，不会留出一圈异色描边。
async function averageOpaqueColor(image) {
    const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += info.channels) {
        if (data[i + 3] < 200) continue;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count += 1;
    }
    if (!count) throw new Error("source icon has no opaque pixels to sample a background from");
    return {
        r: Math.round(r / count),
        g: Math.round(g / count),
        b: Math.round(b / count)
    };
}

async function main() {
    const source = sharp(SOURCE_ICON);
    const background = await averageOpaqueColor(source);

    // "any" 用途：等比收进正方形画布、透明填充。只修正尺寸声明，不改变观感。
    for (const size of [192, 512]) {
        await source.clone()
            .resize(size, size, { fit: "contain", background: CONTAIN_BG })
            .png()
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
        .png()
        .toFile(path.join(ASSETS_DIR, "dumbpad-maskable-512.png"));

    console.log(`Generated dumbpad-icon-192.png, dumbpad-icon-512.png, dumbpad-maskable-512.png (maskable background rgb(${background.r}, ${background.g}, ${background.b}))`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
