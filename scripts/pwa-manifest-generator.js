const fs = require("fs");
const path = require("path");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "Assets");

function getFiles(dir, basePath = "/") {
  let fileList = [];
  const files = fs.readdirSync(dir);
  const excludeList = [".DS_Store"]; // Add files or patterns to exclude here

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const fileUrl = path.join(basePath, file).replace(/\\/g, "/");

    if (fs.statSync(filePath).isDirectory()) {
      fileList = fileList.concat(getFiles(filePath, fileUrl));
    } else {
      if (!excludeList.includes(file)){
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
    name: siteTitle,
    short_name: siteTitle,
    description: "A professional hybrid markdown notepad",
    start_url: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "minimal-ui"],
    background_color: "#171a21",
    theme_color: "#171a21",
    categories: ["productivity", "utilities"],
    shortcuts: [
      {
        name: "新建草稿",
        short_name: "新建",
        description: "创建一个新的草稿文档",
        url: "/?action=new",
        icons: [{ src: "dumbpad.png", sizes: "192x192" }]
      },
      {
        name: "搜索文档",
        short_name: "搜索",
        description: "快速搜索你的文档",
        url: "/?action=search",
        icons: [{ src: "dumbpad.png", sizes: "192x192" }]
      }
    ],
    icons: [
      {
        src: "dumbpad.png",
        type: "image/png",
        sizes: "192x192",
        purpose: "any maskable"
      },
      {
        src: "dumbpad.png",
        type: "image/png",
        sizes: "512x512",
        purpose: "any maskable"
      }
    ],
    orientation: "any",
    prefer_related_applications: false
  };

  fs.writeFileSync(path.join(ASSETS_DIR, "manifest.json"), JSON.stringify(pwaManifest, null, 2));
  console.log("PWA manifest generated!", pwaManifest);
}

module.exports = { generatePWAManifest };