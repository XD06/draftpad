/**
 * DumbPad Service Worker：管理核心模块预缓存、版本化静态资源 0ms cacheFirst、
 * 已缓存 App Shell 秒开与后台重验，以及静态运行时（vendor/font）安全继承策略。
 */
let APP_VERSION = "1.0.0";
let RUNTIME_FINGERPRINT = "default";
const getCacheName = (version) => `DUMBPAD_CACHE_${version}`;
let CURRENT_CACHE_NAME = getCacheName(APP_VERSION);
const CORE_ASSETS = [
  "/index.html",
  "/app.js",
  "/sidebar.js",
  "/Assets/styles.css",
  "/Assets/preview-styles.css",
  "/Assets/attachment-viewer-modal.css",
  "/Assets/thoughts.css",
  "/Assets/today-drafts.css",
  "/Assets/ios-theme.css",
  "/Assets/manifest.json",
  // 唯一被 SW 控制页（index.html favicon/apple-touch）引用的图标；maskable
  // 与 512 只在安装期由系统拉取，login.html 不受 SW 控制都不进预缓存。
  "/Assets/dumbpad-icon-192.png",
  "/js/marked/marked.esm.js",
  // managers/preview.js 现在从 app.js 的模块图可达（附件浮层复用它的渲染），
  // 它的动态 import 也必须能在离线冷启动时命中预缓存。
  "/js/@highlightjs/highlight.min.js",
  "/js/marked-highlight/index.js",
  "/js/marked-extended-tables/index.js",
  "/js/marked-alert/index.js",
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
  "/managers/rendered-snapshot-cache.js",
  "/managers/appearance-presets.js",
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
  "/managers/attachment-rename-dialog.js",
  "/managers/attachment-viewer-modal.js",
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
  "/managers/tiptap-table-stack.js",
  "/managers/tiptap-task-item-view.js",
  "/managers/tiptap-code-block-view.js",
  "/managers/code-language-catalog.js",
  "/managers/code-fence-command.js",
  "/managers/article-block-move.js",
  "/managers/mermaid-render.js",
];

// Fonts and the editor runtime are cached on demand via cacheFirst or WARM_RUNTIME_URLS.
// (Never pre-fetched as blocking install-time assets.)
const WARM_ASSETS = [];

// Versioned immutable runtime: runtime bundles + fonts stay cache-first, and
// carry-over across cache versions is gated by RUNTIME_FINGERPRINT; app JS/CSS
// carrying ?v=<8hex> content hashes also go straight to cacheFirst (0ms hit).
const CACHE_FIRST_PATH_PREFIXES = ['/vendor/', '/font/'];
const isCacheFirstPath = (pathname) => CACHE_FIRST_PATH_PREFIXES.some(prefix => pathname.startsWith(prefix));
const VERSION_HASH_QUERY_RE = /(?:^|&)v=[0-9a-f]{8,}(?:&|$)/i;
const isVersionedImmutableAsset = (url) =>
  url.origin === self.location.origin &&
  VERSION_HASH_QUERY_RE.test(url.search.slice(1)) &&
  !url.pathname.startsWith('/Assets/dumbpad-');
const RUNTIME_FP_KEY = '/__dumbpad_runtime_fp__';

const NETWORK_FIRST_STATIC_EXTENSIONS = [".js", ".css", ".json"];
// Fallback windows for unversioned requests and cold-cache first visits.
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
    if (typeof Response === 'function') {
      await cache.put(RUNTIME_FP_KEY, new Response(RUNTIME_FINGERPRINT));
    }
    console.log("Core assets to cache:", { assetsToCache: CORE_ASSETS });
    // 逐个 add 而不是 cache.addAll：addAll 是全有或全无，任一 404 会让整个
    // activate 抛出——而 install 里的 skipWaiting 已经生效，旧 SW 与旧缓存都
    // 可能已经让位，离线于是整段失效且没有补救路径。逐项失败只降级成「少缓存
    // 了这一个文件」，其余照常可用，失败项进日志。
    const coreResults = await Promise.allSettled(
      CORE_ASSETS.map(async (asset) => {
        if (await cache.match(asset)) return;
        const assetUrl = new URL(asset, self.location.origin);
        if (isVersionedImmutableAsset(assetUrl)) {
          const existing = await caches.match(asset);
          if (existing && existing.ok) {
            const toStore = typeof existing.clone === 'function' ? existing.clone() : existing;
            await cache.put(asset, toStore);
            return;
          }
        }
        try {
          await cache.add(asset);
        } catch (error) {
          const fallback = await caches.match(asset);
          if (fallback && fallback.ok) {
            const toStore = typeof fallback.clone === 'function' ? fallback.clone() : fallback;
            await cache.put(asset, toStore);
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
    // 仅当运行时指纹（RUNTIME_FINGERPRINT）完全一致时，才继承旧桶里按需缓存的
    // /vendor/ 与 /font/ 条目；依赖或字体更新后指纹变化，旧桶直接作废，杜绝陈旧污染。
    try {
      const existingNames = (await caches.keys()).filter(name => isDumbPadCache(name) && name !== cacheName);
      for (const oldName of existingNames) {
        const oldCache = await caches.open(oldName);
        const oldFpRes = await oldCache.match(RUNTIME_FP_KEY);
        const oldFp = oldFpRes && typeof oldFpRes.text === 'function' ? await oldFpRes.text() : null;
        if (oldFp !== RUNTIME_FINGERPRINT) continue;
        const requests = await oldCache.keys();
        for (const req of requests) {
          const pathname = new URL(req.url).pathname;
          if (isCacheFirstPath(pathname) && !(await cache.match(req))) {
            const res = await oldCache.match(req);
            if (res && res.ok) {
              const toStore = typeof res.clone === 'function' ? res.clone() : res;
              await cache.put(req, toStore);
            }
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
  const toStore = typeof response.clone === "function" ? response.clone() : response;
  await cache.put(request, toStore);
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

const appShellInstantWithRevalidate = async (event) => {
  const cached = (await caches.match(event.request)) || (await findCachedFallback(["/index.html"]));
  const revalidate = (async () => {
    const preloaded = event.preloadResponse ? await event.preloadResponse : null;
    const response = preloaded || (await fetch(event.request, { cache: "no-store" }));
    if (response && response.ok && !response.redirected) {
      const cache = await caches.open(CURRENT_CACHE_NAME);
      const copy1 = typeof response.clone === "function" ? response.clone() : response;
      const copy2 = typeof response.clone === "function" ? response.clone() : response;
      await cache.put("/index.html", copy1);
      await cache.put(event.request, copy2);
    } else if (response && response.redirected) {
      const cache = await caches.open(CURRENT_CACHE_NAME);
      if (typeof cache.delete === "function") {
        await cache.delete("/index.html");
        await cache.delete(event.request);
      }
    }
    return response;
  })();

  if (cached) {
    if (typeof event.waitUntil === "function") {
      event.waitUntil(revalidate.catch(() => {}));
    } else {
      revalidate.catch(() => {});
    }
    return cached;
  }

  return networkFirstWithTimeout(event.request, {
    timeout: NAVIGATION_NETWORK_TIMEOUT,
    fetchOptions: { cache: "no-store" },
    fallbackRequests: ["/index.html"],
    preloadResponse: revalidate,
    shouldCache: (response) => Boolean(response && response.ok && !response.redirected),
  });
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

  // Share pages (/s/:id?t=...) are server-rendered tokenized HTML outside the SPA
  // shell: never enforce the 600ms timeout, cache share HTML, or fall back to
  // /index.html (relative paths under /s/ break all CSS/JS when /index.html is served).
  if (requestUrl.pathname.startsWith("/s/")) {
    event.respondWith(
      Promise.resolve(event.preloadResponse)
        .catch(() => null)
        .then((preloaded) => preloaded || fetch(event.request))
    );
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
    // App Shell 导航：已缓存且非显式强制刷新时走 0ms SWR（立即返回本地壳 + 后台重验），
    // 登录页 /login 或显式 reload 保持 networkFirst 语义；过期会话由后台重验清理缓存。
    const isAppShellNavigation =
      requestUrl.pathname === "/" || requestUrl.pathname === "/index.html";
    const isExplicitReload = event.request.cache === "reload" || event.request.cache === "no-cache";
    if (isAppShellNavigation && !isExplicitReload) {
      event.respondWith(appShellInstantWithRevalidate(event));
      return;
    }
    event.respondWith(
      networkFirstWithTimeout(event.request, {
        timeout: NAVIGATION_NETWORK_TIMEOUT,
        fetchOptions: { cache: "no-store" },
        fallbackRequests: isAppShellNavigation ? ["/index.html"] : [],
        preloadResponse: event.preloadResponse,
        shouldCache: (response) => response.ok && !response.redirected,
      })
    );
    return;
  }

  if (isStaticAsset) {
    // 内容哈希版静态资源（?v=<hash>）与运行时目录走 0ms cacheFirst；
    // 未带版本号的请求保留 450ms networkFirst 兜底。
    if (isCacheFirstPath(requestUrl.pathname) || isVersionedImmutableAsset(requestUrl)) {
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

const warmRuntimeUrls = async (urls = []) => {
  if (!Array.isArray(urls) || urls.length === 0) return;
  try {
    const cache = await caches.open(CURRENT_CACHE_NAME);
    for (const rawUrl of urls) {
      if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/')) continue;
      const parsed = new URL(rawUrl, self.location.origin);
      if (parsed.origin !== self.location.origin) continue;
      const target = `${parsed.pathname}${parsed.search}`;
      const hit = (await cache.match(target)) || (await caches.match(target));
      if (!hit) {
        try {
          await cache.add(target);
        } catch (_err) {
          // 离线或单文件失败时静默跳过，不打断后续预热。
        }
      }
    }
  } catch (_err) {
    // 预热仅做离线加速兜底。
  }
};

// Handle messages from the main thread
self.addEventListener("message", (event) => {
  if (!event.data) return;

  if (event.data.type === 'SKIP_WAITING') {
    console.log('Skipping waiting...');
    self.skipWaiting();
    return;
  }

  if (event.data.type === 'WARM_RUNTIME_URLS') {
    const work = warmRuntimeUrls(event.data.urls);
    if (typeof event.waitUntil === 'function') event.waitUntil(work);
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
