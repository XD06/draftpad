/**
 * 生成 PWA Web App Manifest（public/Assets/manifest.json）与静态资源清单
 * （public/Assets/asset-manifest.json），仅在内容变化时落盘以避免无意义 mtime 抖动。
 */
const fs = require("fs");
const path = require("path");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "Assets");

function writeFileIfChanged(targetPath, content) {
  try {
    if (fs.existsSync(targetPath) && fs.readFileSync(targetPath, "utf8") === content) {
      return false;
    }
  } catch (_error) {
    // 读旧文件失败时直接覆盖重写。
  }
  fs.writeFileSync(targetPath, content);
  return true;
}

function getFiles(dir, basePath = "/") {
  let fileList = [];
  const files = fs.readdirSync(dir);
  const excludeList = new Set([
    ".DS_Store",
    "asset-manifest.json",
    "manifest.json",
    "1.png",
    "2.png",
    "12.png",
    "22.png",
    "test.png",
    "2_64x64.ico",
    "2_256x256.ico",
  ]);

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const fileUrl = path.join(basePath, file).replace(/\\/g, "/");

    if (fs.statSync(filePath).isDirectory()) {
      fileList = fileList.concat(getFiles(filePath, fileUrl));
    } else {
      if (!excludeList.has(file)) {
        fileList.push(fileUrl);
      }
    }
  });

  return fileList;
}

function generateAssetManifest() {
  const assets = getFiles(PUBLIC_DIR);
  writeFileIfChanged(path.join(ASSETS_DIR, "asset-manifest.json"), JSON.stringify(assets, null, 2));
  console.log("Asset manifest generated!", assets);
}

function generatePWAManifest(siteTitle) {
  generateAssetManifest(); // fetched later in service-worker

  const pwaManifest = {
    name: siteTitle || "DumbPad",
    short_name: "DumbPad",
    description: "极简、高效、Agent友好的 Markdown 记事本",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // 不写 display_override：它按「第一个被支持的模式」解析，Edge Android
    // 支持 minimal-ui，会让安装出的应用退化成带标题栏的浏览器观感。纯
    // standalone 才是 Chrome/AIHOT 式的无栏沉浸。
    launch_handler: {
      client_mode: ["focus-existing", "auto"]
    },
    background_color: "#f2f2f7",
    theme_color: "#f2f2f7",
    categories: ["productivity", "utilities", "education"],
    lang: "zh-CN",
    dir: "ltr",
    shortcuts: [
      {
        name: "新建草稿",
        short_name: "新建",
        description: "打开即时草稿，记下现在要做的事",
        url: "/#today",
        icons: [{ src: "dumbpad-icon-192.png?v=3", sizes: "192x192" }]
      },
      {
        name: "全文搜索",
        short_name: "搜索",
        description: "在所有文档中搜索",
        url: "/?action=search",
        icons: [{ src: "dumbpad-icon-192.png?v=3", sizes: "192x192" }]
      }
    ],
    // 仅声明圆角外 100% 透明（alpha = 0）的 purpose: "any" 图标，不声明填满方框的
    // maskable 图标：Edge Android 在 PWA 启动屏上会把 maskable 图标原样画成整块
    // 不透明正方形（不套蒙版），且不同浏览器/深浅色系统对启动屏背景有微调，实心
    // 方形底色必然显出格格不入的方框；同时追加 ?v=3 破除卸载重装后浏览器与 WebAPK
    // 对旧 URL 的磁盘缓存残留。
    icons: [
      {
        src: "dumbpad-icon-192.png?v=3",
        type: "image/png",
        sizes: "192x192",
        purpose: "any"
      },
      {
        src: "dumbpad-icon-512.png?v=3",
        type: "image/png",
        sizes: "512x512",
        purpose: "any"
      }
    ],
    orientation: "portrait-primary",
    prefer_related_applications: false
  };

  writeFileIfChanged(path.join(ASSETS_DIR, "manifest.json"), JSON.stringify(pwaManifest, null, 2));
  console.log("PWA manifest generated!", pwaManifest);
}

module.exports = { generatePWAManifest };
