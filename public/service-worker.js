let APP_VERSION = "1.0.0";
let CURRENT_CACHE_NAME = "DUMBPAD_CACHE_1.0.0";

const getCacheName = (version) => `DUMBPAD_CACHE_${version}`;

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
  const dumbpadCaches = cacheNames.filter(name => name.startsWith('DUMBPAD_CACHE_') || name.startsWith('DUMBPAD_PWA_CACHE'));
  
  if (dumbpadCaches.length === 0) {
    return null; // No cache exists
  }
  
  // Extract version from cache name (e.g., "DUMBPAD_CACHE_1.0.1" -> "1.0.1")
  const latestCache = dumbpadCaches[dumbpadCaches.length - 1];
  return latestCache.replace('DUMBPAD_CACHE_', '');
};

const installNewCache = async (version) => {
  const cacheName = getCacheName(version);
  CURRENT_CACHE_NAME = cacheName;
  console.log("Installing new cache:", cacheName);

  const cache = await caches.open(cacheName);
  
  try {
    const response = await fetch("/asset-manifest.json");
    const assets = await response.json();
    const assetsToCache = [
      ...assets,
      // Dynamically added packages
      "/js/marked/marked.esm.js",
      "/js/marked-extended-tables/index.js",
      "/js/marked-alert/index.js",
      "/js/@highlightjs/highlight.min.js",
      "/css/@highlightjs/github.min.css",
      "/css/@highlightjs/github-dark.min.css",
    ];

    // If needed, cache highlight.js languages dynamically
    const configData = await getConfig();
    const highlightLanguages = configData?.highlightLanguages;
    if (highlightLanguages) {
      highlightLanguages.forEach(lang => {
        if (lang.trim()) {
          assetsToCache.push(`/js/@highlightjs/languages/${lang.trim()}.min.js`);
        }
      });
    }
    
    console.log("Assets to cache:", { assetsToCache });
    await cache.addAll(assetsToCache);
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

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  const networkFirstExtensions = [".html", ".js", ".css", ".json"];
  const isNavigation = event.request.mode === "navigate";
  const isNetworkFirstAsset = networkFirstExtensions.some(ext => requestUrl.pathname.endsWith(ext));

  if (isNavigation) {
    // Always fetch fresh index.html, fallback to cache only when offline
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((response) => {
          const copy = response.clone();
          caches.open(CURRENT_CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  if (isNetworkFirstAsset) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CURRENT_CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
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
