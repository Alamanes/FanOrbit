// Avatar downloader: fetch avatar blobs into the IndexedDB cache, with
// retry and per-URL de-duplication.

globalThis.Downloader = (() => {
  const CONCURRENCY = 8;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchWithRetry(url, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const res = await fetch(url, { credentials: 'omit', signal: controller.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        if (!blob || blob.size === 0) throw new Error('empty image');
        return blob;
      } catch (e) {
        if (i === attempts - 1) return null;
        await sleep(500 * (i + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  async function download(items, onProgress) {
    const results = new Array(items.length);
    let cursor = 0;
    let done = 0;
    let failed = 0;

    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) break;
        const item = items[idx];
        let blob = null;
        if (item && item.avatar) {
          try {
            blob = await AvatarCache.get(item.avatar);
            if (!blob) {
              blob = await fetchWithRetry(item.avatar);
              if (blob) {
                try {
                  await AvatarCache.put(item.avatar, blob);
                } catch (e) {
                  // Cache failure is not fatal.
                }
              }
            }
          } catch (e) {
            blob = null;
          }
        }
        results[idx] = { ...item, blob, cached: !!blob };
        if (!blob) failed++;
        done++;
        if (onProgress) {
          try {
            onProgress({ done, total: items.length, failed });
          } catch (e) {
            // Ignore progress callback failures.
          }
        }
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, items.length)) }, worker));
    return { results, failed, ok: results.filter((r) => r && r.blob) };
  }

  return { download, fetchWithRetry };
})();
