let APP_VERSION = "1.0.0";
let CURRENT_CACHE_NAME = "DUMBPAD_CACHE_1.0.0";

const getCacheName = (version) => `DUMBPAD_CACHE_${version}`;
const CORE_ASSETS = [
  "/index.html",
  "/app.js",
  "/hybrid-editor.js",
  "/sidebar.js",
  "/Assets/styles.css",
  "/Assets/preview-styles.css",
  "/Assets/thoughts.css",
  "/Assets/ios-theme.css",
  "/Assets/manifest.json",
  "/Assets/dumbpad.png",
  "/Assets/dumbpad-192.png",
  "/Assets/dumbpad-512.png",
  "/Assets/favicon-512.png",
  "/vendor/vditor/index.css",
  "/vendor/vditor/index.min.js",
  "/vendor/vditor-package/dist/js/i18n/zh_CN.js",
  "/vendor/vditor-package/dist/js/lute/lute.min.js",
  "/js/marked/marked.esm.js",
  "/css/@highlightjs/github.min.css",
  "/css/@highlightjs/github-dark.min.css",
  "/managers/confirmation.js",
  "/managers/preview.js",
  "/managers/settings.js",
  "/managers/settings-data-panel.js",
  "/managers/storage.js",
  "/managers/note-sync-controller.js",
  "/managers/thoughts.js",
  "/managers/thought-api-client.js",
  "/managers/thought-editor.js",
  "/managers/thought-outbox.js",
  "/managers/thought-relations-panel.js",
  "/managers/thought-renderer.js",
  "/managers/toaster.js",
  "/managers/ws-client.js",
];

const WARM_ASSETS = [
  "/font/LXGWWenKai-Regular.ttf",
  "/font/FiraCode-Regular.ttf",
  "/js/@highlightjs/highlight.min.js",
];

const getConfig = async () => {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Failed to fetch config:", error);
    return null;
  }
}

const getAppVersion = async () => {
  try {
    const data = await getConfig();
    if (!data || !data.version) {
      console.warn("No version found in config, using default:", APP_VERSION);
      return APP_VERSION;
    }
    APP_VERSION = data.version;
    CURRENT_CACHE_NAME = getCacheName(APP_VERSION);
    console.log("App version:", APP_VERSION, "Cache:", CURRENT_CACHE_NAME);
    return data.version;
  } catch (error) {
    console.error("Failed to fetch app version:", error);
    return APP_VERSION;
  }
};

const getCurrentCacheVersion = async () => {
  const cacheNames = await caches.keys();
  return cacheNames.includes(CURRENT_CACHE_NAME) ? APP_VERSION : null;
};

const installNewCache = async (version) => {
  const cacheName = getCacheName(version);
  CURRENT_CACHE_NAME = cacheName;
  console.log("Installing new cache:", cacheName);

  const cache = await caches.open(cacheName);
  
  try {
    console.log("Core assets to cache:", { assetsToCache: CORE_ASSETS });
    await cache.addAll(CORE_ASSETS);
    console.log("Warm assets to cache:", { assetsToCache: WARM_ASSETS });
    const warmResults = await Promise.allSettled(
      WARM_ASSETS.map(async (asset) => {
        if (await cache.match(asset)) return;
        await cache.add(asset);
      })
    );
    const warmFailed = warmResults.filter(result => result.status === "rejected").length;
    if (warmFailed) {
      console.warn("Some warm assets were not cached:", { failed: warmFailed, total: WARM_ASSETS.length });
    }
    console.log("Cache installation complete for version:", version);
  } catch (error) {
    console.error("Failed to install cache:", error);
    throw error;
  }
};

const cleanupOldCaches = async (currentVersion) => {
  const currentCacheName = getCacheName(currentVersion);
  console.log("Cleaning up old caches, keeping current cache:", currentCacheName);

  const cacheNames = await caches.keys();
  const deletePromises = cacheNames
    .filter(name => (name.startsWith('DUMBPAD_CACHE_') || name.startsWith('DUMBPAD_PWA_CACHE')) && name !== currentCacheName)
    .map(name => {
      console.log("Deleting old cache:", name);
      return caches.delete(name);
    });

  return Promise.all(deletePromises);
};

const checkAndUpdateCache = async () => {
  console.log("Checking cache version...");
  
  const appVersion = await getAppVersion();
  const cacheVersion = await getCurrentCacheVersion();
  
  console.log("App version:", appVersion);
  console.log("Cache version:", cacheVersion);
  
  if (!cacheVersion) {
    // First time installation
    console.log("First time installation - installing cache");
    await installNewCache(appVersion);
    return { updated: true, firstInstall: true };
  }
  
  if (cacheVersion !== appVersion) {
    // Version mismatch - update cache
    console.log("Version mismatch - updating cache");
    await installNewCache(appVersion);
    await cleanupOldCaches(appVersion);
    return { updated: true, firstInstall: false };
  }
  
  console.log("Cache up to date");
  return { updated: false, firstInstall: false };
};

self.addEventListener("install", (event) => {
  console.log("Service worker installing...");
  // Pre-fetch version so CURRENT_CACHE_NAME is ready for fetch events
  event.waitUntil(
    getAppVersion().then(() => {
      self.skipWaiting();
    })
  );
});

self.addEventListener("activate", (event) => {
  console.log("Service worker activating...");

  event.waitUntil(
    checkAndUpdateCache().then(({ updated, firstInstall }) => {
      return self.clients.claim().then(() => {
        if (updated && !firstInstall) {
          // Notify clients that an update is available; let user decide when to reload
          console.log("Cache updated - notifying clients");
          self.clients.matchAll().then(clients => {
            clients.forEach(client => {
              client.postMessage({
                type: 'UPDATE_AVAILABLE',
                version: APP_VERSION
              });
            });
          });
        } else if (updated && firstInstall) {
          console.log("Cache installed for first time");
          self.clients.matchAll().then(clients => {
            clients.forEach(client => {
              client.postMessage({
                type: 'CACHE_INSTALLED',
                version: APP_VERSION
              });
            });
          });
        }
      });
    })
  );
});

const putInCache = async (request, response) => {
  if (!response || !response.ok) return;
  const cache = await caches.open(CURRENT_CACHE_NAME);
  await cache.put(request, response.clone());
};

const findCachedFallback = async (fallbackRequests = []) => {
  for (const fallbackRequest of fallbackRequests) {
    const response = await caches.match(fallbackRequest);
    if (response) return response;
  }
  return null;
};

const networkFirstWithTimeout = async (request, options = {}) => {
  const { timeout = 2500, fetchOptions = {}, fallbackRequests = [] } = options;
  const networkRequest = fetch(request, fetchOptions).then((response) => {
    putInCache(request, response).catch(() => {});
    return response;
  });

  try {
    return await Promise.race([
      networkRequest,
      new Promise((_, reject) => setTimeout(() => reject(new Error("network timeout")), timeout)),
    ]);
  } catch (_error) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;

    const fallbackResponse = await findCachedFallback(fallbackRequests);
    if (fallbackResponse) return fallbackResponse;

    return networkRequest.catch(() => {
      return new Response("", {
        status: 504,
        statusText: "Gateway Timeout",
      });
    });
  }
};

const cacheFirst = async (request) => {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) return cachedResponse;

  try {
    const response = await fetch(request);
    putInCache(request, response).catch(() => {});
    return response;
  } catch (_error) {
    return new Response("", {
      status: 504,
      statusText: "Gateway Timeout",
    });
  }
};

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  const staticAssetExtensions = [".js", ".css", ".json", ".png", ".ico", ".svg", ".woff", ".woff2", ".ttf"];
  const isNavigation = event.request.mode === "navigate";
  const isStaticAsset = staticAssetExtensions.some(ext => requestUrl.pathname.endsWith(ext));

  if (isNavigation) {
    // Always fetch fresh index.html, fallback to cache only when offline
    event.respondWith(
      networkFirstWithTimeout(event.request, {
        timeout: 2500,
        fetchOptions: { cache: "no-store" },
        fallbackRequests: ["/index.html"],
      })
    );
    return;
  }

  if (isStaticAsset) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request).catch(() => {
        return new Response("", {
          status: 504,
          statusText: "Gateway Timeout",
        });
      });
    })
  );
});

// Handle messages from the main thread
self.addEventListener("message", (event) => {
  if (!event.data) return;

  if (event.data.type === 'SKIP_WAITING') {
    console.log('Skipping waiting...');
    self.skipWaiting();
    return;
  }

  if (event.data.type === 'CHECK_VERSION') {
    checkAndUpdateCache().then(({ updated, firstInstall }) => {
      event.ports[0].postMessage({
        updated,
        firstInstall,
        version: APP_VERSION
      });
    });
  }
});
