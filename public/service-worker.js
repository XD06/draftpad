let APP_VERSION = "1.0.0";
let CURRENT_CACHE_NAME = "DUMBPAD_CACHE_1.0.0";

const getCacheName = (version) => `DUMBPAD_CACHE_${version}`;
const CORE_ASSETS = [
  "/index.html",
  "/app.js",
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
  "/js/marked/marked.esm.js",
  "/css/@highlightjs/github.min.css",
  "/css/@highlightjs/github-dark.min.css",
  "/managers/confirmation.js",
  "/managers/hybrid-display-sanitizer.js",
  "/managers/preview.js",
  "/managers/settings.js",
  "/managers/settings-data-panel.js",
  "/managers/storage.js",
  "/managers/note-sync-controller.js",
  "/managers/thoughts.js",
  "/managers/agent-api-client.js",
  "/managers/thought-agent-state.js",
  "/managers/thought-agent-panel.js",
  "/managers/thought-agent-controller.js",
  "/managers/thought-ai-status.js",
  "/managers/thought-api-client.js",
  "/managers/asset-api-client.js",
  "/managers/article-file-command.js",
  "/managers/thought-attachments.js",
  "/managers/thought-card-renderer.js",
  "/managers/thought-editor.js",
  "/managers/thought-outbox.js",
  "/managers/thought-quick-add.js",
  "/managers/thought-relations-panel.js",
  "/managers/thought-relations-state.js",
  "/managers/thought-swipe.js",
  "/managers/thought-renderer.js",
  "/managers/thought-tags.js",
  "/managers/thought-text-formatting.js",
  "/managers/time-command.js",
  "/managers/toaster.js",
  "/managers/ws-client.js",
];

// Fonts and the editor runtime are cached by the normal fetch handler after
// first use. Do not force every PWA installation to download optional assets.
const WARM_ASSETS = [];

const NETWORK_FIRST_STATIC_EXTENSIONS = [".js", ".css", ".json"];
const NAVIGATION_NETWORK_TIMEOUT = 900;
const STATIC_NETWORK_TIMEOUT = 650;

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

const isDumbPadCache = (name) => name.startsWith('DUMBPAD_CACHE_') || name.startsWith('DUMBPAD_PWA_CACHE');

const getCacheState = async () => {
  const cacheNames = await caches.keys();
  const appCaches = cacheNames.filter(isDumbPadCache);
  return {
    hasCurrent: cacheNames.includes(CURRENT_CACHE_NAME),
    hasAnyAppCache: appCaches.length > 0,
  };
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
  const cacheState = await getCacheState();
  
  console.log("App version:", appVersion);
  console.log("Cache state:", cacheState);
  
  if (!cacheState.hasCurrent) {
    // Current version is missing. Install it, then clean older DumbPad caches when this is an update.
    console.log(cacheState.hasAnyAppCache ? "Version mismatch - updating cache" : "First time installation - installing cache");
    await installNewCache(appVersion);
    if (cacheState.hasAnyAppCache) await cleanupOldCaches(appVersion);
    return { updated: true, firstInstall: !cacheState.hasAnyAppCache };
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
    (async () => {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }

      const { updated, firstInstall } = await checkAndUpdateCache();
      await self.clients.claim();

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
    })()
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
  const { timeout = 2500, fetchOptions = {}, fallbackRequests = [], preloadResponse = null, shouldCache = () => true } = options;
  const networkRequest = (async () => {
    const preloaded = preloadResponse ? await preloadResponse : null;
    if (preloaded) return preloaded;
    return fetch(request, fetchOptions);
  })().then((response) => {
    if (shouldCache(response)) putInCache(request, response).catch(() => {});
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
  const isNetworkFirstStaticAsset = NETWORK_FIRST_STATIC_EXTENSIONS.some(ext => requestUrl.pathname.endsWith(ext));

  if (isNavigation) {
    // Always fetch fresh index.html, fallback to cache only when offline.
    // Never cache redirected (e.g. → /login) responses under the original URL:
    // otherwise a logged-out navigation can pollute the "/" cache slot with the
    // login page, or leave a stale app shell that hides the login redirect.
    event.respondWith(
      networkFirstWithTimeout(event.request, {
        timeout: NAVIGATION_NETWORK_TIMEOUT,
        fetchOptions: { cache: "no-store" },
        fallbackRequests: ["/index.html"],
        preloadResponse: event.preloadResponse,
        shouldCache: (response) => response.ok && !response.redirected,
      })
    );
    return;
  }

  if (isStaticAsset) {
    if (isNetworkFirstStaticAsset) {
      event.respondWith(
        networkFirstWithTimeout(event.request, {
          timeout: STATIC_NETWORK_TIMEOUT,
          fetchOptions: { cache: "no-cache" },
          fallbackRequests: [event.request],
        })
      );
      return;
    }

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
