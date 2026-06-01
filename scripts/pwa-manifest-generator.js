const fs = require("fs");
const path = require("path");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "Assets");

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
  fs.writeFileSync(path.join(ASSETS_DIR, "asset-manifest.json"), JSON.stringify(assets, null, 2));
  console.log("Asset manifest generated!", assets);
}

function generatePWAManifest(siteTitle) {
  generateAssetManifest(); // fetched later in service-worker

  const pwaManifest = {
    name: siteTitle || "DumbPad",
    short_name: "DumbPad",
    description: "极简、高效、Agent友好的 Markdown 记事本",
    start_url: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "minimal-ui"],
    background_color: "#0f172a",
    theme_color: "#0f172a",
    categories: ["productivity", "utilities", "education"],
    lang: "zh-CN",
    dir: "ltr",
    shortcuts: [
      {
        name: "新建草稿",
        short_name: "新建",
        description: "创建一个新的草稿文档",
        url: "/?action=new",
        icons: [{ src: "dumbpad-192.png", sizes: "192x192" }]
      },
      {
        name: "全文搜索",
        short_name: "搜索",
        description: "在所有文档中搜索",
        url: "/?action=search",
        icons: [{ src: "dumbpad-192.png", sizes: "192x192" }]
      }
    ],
    icons: [
      {
        src: "dumbpad-192.png",
        type: "image/png",
        sizes: "192x192",
        purpose: "any"
      },
      {
        src: "dumbpad-512.png",
        type: "image/png",
        sizes: "512x512",
        purpose: "any"
      }
    ],
    orientation: "portrait-primary",
    prefer_related_applications: false
  };

  fs.writeFileSync(path.join(ASSETS_DIR, "manifest.json"), JSON.stringify(pwaManifest, null, 2));
  console.log("PWA manifest generated!", pwaManifest);
}

module.exports = { generatePWAManifest };
