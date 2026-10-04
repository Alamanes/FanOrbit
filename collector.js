// FanOrbit fan-list collector: a content script running on the user's
// x.com/<name>/followers page. Scrapes username + avatar from UserCell
// nodes while auto-scrolling. Approach inspired by qiujiu-dev/XAvatarWall,
// with this clean-room reimplementation using only public DOM features.

(() => {
  if (window.__fanorbit_collector__) return;
  window.__fanorbit_collector__ = true;

  let running = false;
  let stopRequested = false;

  const RESERVED = new Set([
    'i', 'home', 'explore', 'notifications', 'messages', 'search',
    'settings', 'compose', 'login', 'signup', 'download', 'tos',
    'privacy', 'help', 'about', 'jobs', 'twitter', 'x'
  ]);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'COLLECT_START') {
      startCollection(msg.config).catch(() => {});
    }
    if (msg.type === 'COLLECT_STOP') {
      stopRequested = true;
    }
    return false;
  });

  // Fallback auto-start after page load, in case the background fails to
  // deliver COLLECT_START in time.
  setTimeout(autoStartIfNeeded, 800);
  setTimeout(autoStartIfNeeded, 3000);

  async function autoStartIfNeeded() {
    if (running) return;
    const { config } = await chrome.storage.local.get('config').catch(() => ({ config: null }));
    if (!config || !config.active || config.status !== 'collecting') return;
    if (!isFollowersPage(config.username)) return;
    startCollection(config).catch(() => {});
  }

  function isFollowersPage(username) {
    if (!username) return false;
    const path = (location.pathname || '').toLowerCase();
    return path.includes('/' + username.toLowerCase() + '/followers');
  }

  async function startCollection(config) {
    if (running) return;
    running = true;
    stopRequested = false;

    const target = config.username;
    const maxCount = normalizeMax(config.maxCount);

    // Resume previously collected data so a page refresh continues the task.
    const seen = new Map();
    const { fansData } = await chrome.storage.local.get('fansData').catch(() => ({}));
    if (fansData && fansData.username === target) {
      (fansData.fans || []).forEach((f) => {
        if (f && f.username) seen.set(f.username, f);
      });
    }

    await waitForCells(15000);

    let noNewStreak = 0;
    const MAX_NO_NEW = 6;

    while (running && !stopRequested) {
      const before = seen.size;
      scanPage(seen);
      await persist(target, seen);
      const after = seen.size;

      if (maxCount !== 'all' && seen.size >= maxCount) break;

      if (after === before) {
        noNewStreak++;
        if (noNewStreak >= MAX_NO_NEW) break;
      } else {
        noNewStreak = 0;
      }

      scrollToLoadMore();
      await sleep(1600 + Math.floor(Math.random() * 600));
    }

    running = false;

    let fans = Array.from(seen.values()).sort((a, b) => a.index - b.index);
    if (maxCount !== 'all') fans = fans.slice(0, maxCount);

    await chrome.storage.local.set({
      fansData: { username: target, fans, total: fans.length, collectedAt: Date.now() },
      progress: {
        current: fans.length,
        max: maxCount === 'all' ? fans.length : maxCount,
        message: stopRequested ? '已停止，粉丝部分可用' : fans.length ? '粉丝采集完成' : '未采集到粉丝'
      }
    });

    if (fans.length) {
      try {
        await chrome.runtime.sendMessage({
          type: 'COLLECT_DONE',
          payload: { total: fans.length, username: target }
        });
      } catch (e) {
        // Ignored: popup can open the generator page manually.
      }
    }
  }

  function scanPage(seen) {
    for (const cell of getCells()) {
      if (seen.size >= 100000) return;
      const username = extractUsername(cell);
      if (!username || seen.has(username)) continue;
      const avatar = extractAvatar(cell);
      if (!avatar) continue;
      seen.set(username, {
        username,
        avatar,
        index: seen.size + 1,
        time: Date.now()
      });
    }
  }

  function getCells() {
    const userCells = document.querySelectorAll('[data-testid="UserCell"]');
    if (userCells.length) return userCells;
    return document.querySelectorAll('[data-testid="cellInnerDiv"]');
  }

  function extractUsername(cell) {
    const anchors = cell.querySelectorAll('a[href^="/"]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
      if (m && !RESERVED.has(m[1].toLowerCase())) return m[1];
    }
    return null;
  }

  function extractAvatar(cell) {
    const imgs = cell.querySelectorAll('img');
    for (const img of imgs) {
      const src = img.getAttribute('src') || img.currentSrc || '';
      if (src && /twimg\.com/.test(src)) return upscaleAvatar(src);
    }
    return null;
  }

  function upscaleAvatar(url) {
    try {
      const u = new URL(url);
      u.pathname = u.pathname
        .replace(/_normal(\.[A-Za-z]+)$/, '_400x400$1')
        .replace(/_mini(\.[A-Za-z]+)$/, '_400x400$1')
        .replace(/_bigger(\.[A-Za-z]+)$/, '_400x400$1')
        .replace(/_200x200(\.[A-Za-z]+)$/, '_400x400$1')
        .replace(/_reasonably_small(\.[A-Za-z]+)$/, '_400x400$1');
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  function scrollToLoadMore() {
    const cells = getCells();
    if (cells.length) {
      try {
        cells[cells.length - 1].scrollIntoView({ block: 'end', inline: 'nearest' });
      } catch (e) {
        window.scrollBy(0, 1200);
      }
    }
    window.scrollBy(0, 1200);
  }

  async function waitForCells(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (stopRequested) return;
      if (getCells().length > 0) return;
      await sleep(500);
    }
  }

  async function persist(target, seen) {
    const fans = Array.from(seen.values()).sort((a, b) => a.index - b.index);
    await chrome.storage.local.set({
      fansData: { username: target, fans, total: fans.length, collectedAt: Date.now() },
      progress: { current: fans.length, max: 0, message: `粉丝采集中 ${fans.length} 位…` }
    });
  }

  function normalizeMax(maxCount) {
    if (maxCount === 'all' || maxCount == null) return 'all';
    const n = parseInt(maxCount, 10);
    return isNaN(n) || n < 1 ? 'all' : n;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
