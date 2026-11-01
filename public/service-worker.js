/**
 * DumbPad Service Worker：管理核心模块预缓存、HTML/JS/CSS 网络优先限时回退与
 * 静态运行时（vendor/font）缓存优先策略，确保离线冷启动与多端更新一致。
 */
let APP_VERSION = "1.0.0";
const getCacheName = (version) => `DUMBPAD_CACHE_${version}`;
let CURRENT_CACHE_NAME = getCacheName(APP_VERSION);
const CORE_ASSETS = [
  "/index.html",
  "/app.js",
  "/sidebar.js",
  "/Assets/styles.css",
  "/Assets/preview-styles.css",
  "/Assets/thoughts.css",
  "/Assets/today-drafts.css",
  "/Assets/ios-theme.css",
  "/Assets/manifest.json",
  // 唯一被 SW 控制页（index.html favicon/apple-touch）引用的图标；maskable
  // 与 512 只在安装期由系统拉取，login.html 不受 SW 控制都不进预缓存。
  "/Assets/dumbpad-icon-192.png",
  "/js/marked/marked.esm.js",
  "/css/@highlightjs/github.min.css",
  "/css/@highlightjs/github-dark.min.css",
  "/managers/confirmation.js",
  "/managers/clipboard-import-coordinator.js",
  "/managers/command-search/command-search-manager.js",
  "/managers/command-search/result-type-registry.js",
  "/managers/floating-actions-config.js",
  "/managers/hybrid-display-sanitizer.js",
  "/managers/import-target-registry.js",
  "/managers/markdown-html-sanitizer.js",
  "/managers/preview.js",
  "/managers/settings.js",
  "/managers/settings-data-panel.js",
  "/managers/storage.js",
  "/managers/note-sync-controller.js",
  "/managers/editor-performance.js",
  "/managers/caret-trace.js",
  "/managers/heading-index.js",
  "/managers/thoughts.js",
  "/managers/today-drafts/today-draft-action-menu.js",
  "/managers/today-drafts/today-drafts-manager.js",
  "/managers/today-drafts/today-drafts-api-client.js",
  "/managers/today-drafts/today-drafts-outbox.js",
  "/managers/today-drafts/today-drafts-paging.js",
  "/managers/today-drafts/today-drafts-renderer.js",
  "/managers/today-drafts/today-drafts-swipe.js",
  "/managers/today-drafts/today-drafts-store.js",
  "/managers/workspace-router.js",
  "/managers/agent-api-client.js",
  "/managers/thought-agent-state.js",
  "/managers/thought-agent-panel.js",
  "/managers/thought-agent-controller.js",
  "/managers/thought-ai-status.js",
  "/managers/thought-api-client.js",
  "/managers/asset-api-client.js",
  "/managers/file-type-icons.js",
  "/managers/article-file-command.js",
  "/managers/article-meta-footer.js",
  "/managers/article-title.js",
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
  "/tiptap-editor.js",
  "/managers/tiptap-runtime.js",
  "/managers/tiptap-extensions.js",
  "/managers/tiptap-selection-menu.js",
  "/managers/selection-menu-icons.js",
  "/managers/tiptap-slash-menu.js",
  "/managers/tiptap-file-command.js",
  "/managers/tiptap-image-interactions.js",
  "/managers/tiptap-image-paste.js",
  "/managers/tiptap-pointer-focus.js",
  "/managers/tiptap-media.js",
  "/managers/tiptap-task-item-view.js",
  "/managers/tiptap-code-block-view.js",
  "/managers/code-language-catalog.js",
  "/managers/code-fence-command.js",
  "/managers/article-block-move.js",
  "/managers/mermaid-render.js",
];

// Fonts and the editor runtime are cached by the normal fetch handler after
// first use. Do not force every PWA installation to download optional assets.
// (First-paint parallelism is handled by <link rel=preload> in index.html,
// which is per-navigation and does not bloat install-time caching.)
const WARM_ASSETS = [];

// Versioned immutable runtime: vendor bundle + fonts change only with a new
// BUILD_VERSION (server fingerprints the whole public/ dir into the cache
// name), so within one cache version they are immutable and safe for
// cache-first. App code (app.js, managers/*, *.css) stays network-first
// because it changes without a content hash in the URL.
const CACHE_FIRST_PATH_PREFIXES = ['/vendor/', '/font/'];
const isCacheFirstPath = (pathname) => CACHE_FIRST_PATH_PREFIXES.some(prefix => pathname.startsWith(prefix));

const NETWORK_FIRST_STATIC_EXTENSIONS = [".js", ".css", ".json"];
// How long a navigation/static request may stall on a slow (e.g. home-server
// over WAN) link before we fall back to the cached copy. Kept short because
// the fallback is the same versioned cache the network response would have
// refreshed: a timeout only trades one fresh copy for the previous identical
// one, while a long timeout delays first paint on every refresh.
const NAVIGATION_NETWORK_TIMEOUT = 600;
const STATIC_NETWORK_TIMEOUT = 450;

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
    // 逐个 add 而不是 cache.addAll：addAll 是全有或全无，任一 404 会让整个
    // activate 抛出——而 install 里的 skipWaiting 已经生效，旧 SW 与旧缓存都
    // 可能已经让位，离线于是整段失效且没有补救路径。逐项失败只降级成「少缓存
    // 了这一个文件」，其余照常可用，失败项进日志。
    const coreResults = await Promise.allSettled(
      CORE_ASSETS.map(async (asset) => {
        if (await cache.match(asset)) return;
        try {
          await cache.add(asset);
        } catch (error) {
          const fallback = await caches.match(asset);
          if (fallback && fallback.ok) {
            await cache.put(asset, fallback.clone());
            return;
          }
          throw error;
        }
      })
    );
    const coreFailed = coreResults
      .map((result, index) => (result.status === "rejected" ? CORE_ASSETS[index] : null))
      .filter(Boolean);
    if (coreFailed.length) {
      console.warn("Some core assets were not cached:", { failed: coreFailed });
    }
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
    // 继承旧缓存里已按需拉取过的不可变运行时（/vendor/、/font/），避免小版本
    // 升级后清理旧桶把 800KB+ 的编辑器内核与字体一并蒸发。
    try {
      const existingNames = (await caches.keys()).filter(name => isDumbPadCache(name) && name !== cacheName);
      for (const oldName of existingNames) {
        const oldCache = await caches.open(oldName);
        const requests = await oldCache.keys();
        for (const req of requests) {
          const pathname = new URL(req.url).pathname;
          if (isCacheFirstPath(pathname) && !(await cache.match(req))) {
            const res = await oldCache.match(req);
            if (res && res.ok) await cache.put(req, res.clone());
          }
        }
      }
    } catch (carryError) {
      console.warn("Failed to carry over runtime cache entries:", carryError);
    }
    console.log("Cache installation complete for version:", version);
    return { coreFailed };
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
    const { coreFailed } = await installNewCache(appVersion);
    if (cacheState.hasAnyAppCache && (!coreFailed || coreFailed.length === 0)) {
      await cleanupOldCaches(appVersion);
    }
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

  const staticAssetExtensions = [".js", ".css", ".json", ".png", ".ico", ".svg", ".woff", ".woff2", ".ttf", ".wasm"];
  const isNavigation = event.request.mode === "navigate";
  const isStaticAsset = staticAssetExtensions.some(ext => requestUrl.pathname.endsWith(ext));
  const isPwaBrandIcon =
    requestUrl.pathname.startsWith("/Assets/dumbpad-") && requestUrl.pathname.endsWith(".png");
  const isNetworkFirstStaticAsset =
    NETWORK_FIRST_STATIC_EXTENSIONS.some(ext => requestUrl.pathname.endsWith(ext)) ||
    isPwaBrandIcon;

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
    // Immutable vendor/font runtime: serve from cache instantly (PWA warm
    // start), refresh in background on next navigation if version changed
    // (version change creates a new cache name, so staleness is impossible).
    if (isCacheFirstPath(requestUrl.pathname)) {
      event.respondWith(cacheFirst(event.request));
      return;
    }
    if (isNetworkFirstStaticAsset) {
      event.respondWith(
        networkFirstWithTimeout(event.request, {
          timeout: STATIC_NETWORK_TIMEOUT,
          fetchOptions: { cache: "no-cache" },
          fallbackRequests: [event.request, requestUrl.pathname],
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
