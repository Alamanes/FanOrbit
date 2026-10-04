// FanOrbit service worker: orchestrates fan collection, public-data
// interaction scanning, scoring, and opens the generator page.

import { fetchInteractionBundle, fetchSelfAvatar } from './lib/interaction.js';
import { computeScores } from './lib/scoring.js';

const TAB_URL = (name) => `https://x.com/${name}/followers`;
const GEN_URL = chrome.runtime.getURL('generator.html');
let collectTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'START':
        await handleStart();
        break;
      case 'GEN_OPEN':
        await openGenerator();
        break;
      case 'COLLECT_DONE':
        await onCollectDone(msg.payload || {});
        break;
      case 'STATUS':
        sendResponse(await statusPayload());
        return;
    }
    sendResponse({ ok: true });
  })();
  return true;
});

async function statusPayload() {
  const { config, progress, fansData, interactionData } = await chrome.storage.local.get();
  return {
    config,
    progress: progress || { current: 0, max: 0, message: '待开始' },
    total: (fansData && fansData.total) || 0,
    scored: interactionData ? Object.keys(interactionData.scores || {}).length : 0
  };
}

async function handleStart() {
  const { config } = await chrome.storage.local.get('config');
  if (!config || !config.username) return;

  await chrome.storage.local.set({
    config: { ...config, active: true, stop: false },
    progress: { current: 0, max: 0, message: '正在打开粉丝页…' }
  });

  // Only one collection tab at a time.
  if (collectTabId != null) {
    try {
      const tab = await chrome.tabs.get(collectTabId);
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        return;
      }
    } catch (e) {
      collectTabId = null;
    }
  }

  chrome.tabs.create({ url: TAB_URL(config.username) }, (tab) => {
    collectTabId = tab ? tab.id : null;
  });
}

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (tabId !== collectTabId || info.status !== 'complete') return;
  const { config } = await chrome.storage.local.get('config');
  if (!config || !config.active || config.status === 'scanning') return;
  await chrome.storage.local.set({
    config: { ...config, status: 'collecting' },
    progress: { current: 0, max: 0, message: '粉丝采集中…' }
  });
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'COLLECT_START', config });
  } catch (e) {
    // Content script not ready yet; collector auto-starts on its own.
  }
});

async function onCollectDone(payload) {
  const { config } = await chrome.storage.local.get('config');
  if (!config || !config.active) return;

  await chrome.storage.local.set({
    config: { ...config, status: 'scanning', active: false },
    progress: { current: 0, max: 0, message: '互动数据采集中（公开数据源）…' }
  });

  // Close the collection tab so it does not sit around during the scan.
  if (collectTabId != null) {
    try { await chrome.tabs.remove(collectTabId); } catch (e) { /* already gone */ }
    collectTabId = null;
  }

  try {
    const { username, scanMode } = config;
    const bundle = await fetchInteractionBundle(username, scanMode || 'fast');
    const scores = computeScores(bundle.events, normalize(username));

    let selfAvatar = null;
    try {
      selfAvatar = await fetchSelfAvatar(username);
    } catch (e) {
      // Generator falls back to a placeholder center avatar.
    }

    await chrome.storage.local.set({
      interactionData: {
        username,
        scores,
        scoreByName: Object.fromEntries(scores.map((s) => [s.screenName, s])),
        avatars: bundle.avatars,
        selfAvatar,
        sources: bundle.sources,
        failures: bundle.failures,
        scannedAt: Date.now()
      },
      progress: {
        current: scores.length,
        max: scores.length,
        message: `互动扫描完成：${scores.length} 位有互动记录（源：${bundle.sources.join('、') || '无'}` +
          (bundle.failures.length ? `；不可用：${bundle.failures.join('、')}` : '') + '）'
      }
    });
  } catch (e) {
    await chrome.storage.local.set({
      config: { ...config, status: 'error', active: false },
      progress: { current: 0, max: 0, message: '互动扫描失败：' + (e && e.message || e) }
    });
    return;
  }

  await openGenerator();
}

async function openGenerator() {
  const { config } = await chrome.storage.local.get('config');
  if (!config || !config.username) return;
  await chrome.storage.local.set({
    config: { ...config, active: false, status: 'generating' }
  });
  chrome.tabs.create({ url: GEN_URL });
}

function normalize(raw) {
  return (raw || '').toString().replace(/^@/, '').trim().toLowerCase();
}
