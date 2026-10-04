// Public-data interaction collection, modeled after NekoCircle's approach
// (https://github.com/acnekot/NekoCircle): fetch tweets mentioning the user
// from three anonymous public sources (Yahoo! Japan realtime search, Bing
// web search restricted to x.com, and the fxtwitter v2 API), convert them
// into unified interaction events, then merge and score. No X login
// required. Yahoo is unavailable outside Japan IPs; Bing and fxtwitter
// work worldwide, so the bundle degrades gracefully.

import { normalizeUsername, upscaleTwitterAvatar } from './util.js';

const YAHOO_RT = 'https://search.yahoo.co.jp/realtime/api/v1/pagination';
const YAHOO_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://search.yahoo.co.jp/realtime/search'
};
const BING_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ja;q=0.7,zh-CN;q=0.5',
  'Accept-Encoding': 'identity',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  Referer: 'https://www.bing.com/'
};
const TWEET_URL_RE =
  /https?:\/\/(?:mobile\.|m\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/gi;
const FX_API = 'https://api.fxtwitter.com/2';

const RESULTS_PER_PAGE = 40;
const LIMITS = {
  fast: { yahooPages: 10, yahooEntries: 400, fxPages: 5, bingPages: 4 },
  deep: { yahooPages: 20, yahooEntries: 2000, fxPages: 15, bingPages: 8 }
};
const FX_PAGE_SIZE = 100;

export async function fetchInteractionBundle(screenName, mode = 'fast') {
  const self = normalizeUsername(screenName);
  if (!self) throw new Error('empty screen name');

  const [yahoo, bing, fx] = await Promise.allSettled([
    yahooEvents(self, mode),
    bingEvents(self, mode),
    fxEvents(self, mode)
  ]);

  const events = [];
  const avatars = {};
  const sources = [];
  const failures = [];

  for (const r of [yahoo, bing, fx]) {
    if (r.status === 'fulfilled') {
      events.push(...r.value.events);
      Object.assign(avatars, r.value.avatars);
      sources.push(r.value.source);
    } else {
      failures.push(String(r.reason && r.reason.message || r.reason));
    }
  }

  return { events, avatars, sources, failures };
}

// ---------------------------------------------------------------- Yahoo ---

const YAHOO_MAX_CONSECUTIVE_EMPTY = 2;

async function yahooEvents(self, mode) {
  const limit = LIMITS[mode] || LIMITS.fast;
  const events = [];
  const avatars = {};
  const seen = new Set();

  // Inbound: who mentioned / replied to self (excluding self tweets).
  await yahooQuery(`@${self} -from:${self}`, limit, seen, events, avatars, self, true);
  // Outbound: self tweets, harvesting mention targets.
  await yahooQuery(`ID:${self}`, limit, seen, events, avatars, self, false);

  return { source: 'yahoo', events, avatars };
}

async function yahooQuery(p, limit, seen, events, avatars, self, inbound) {
  for (let pageIdx = 0; pageIdx < limit.yahooPages; pageIdx++) {
    const start = pageIdx * RESULTS_PER_PAGE + 1;
    const url = `${YAHOO_RT}?p=${encodeURIComponent(p)}&results=${RESULTS_PER_PAGE}&start=${start}`;
    let data;
    try {
      const res = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      throw new Error(`yahoo: ${e.message}`);
    }

    const entries = (data && data.timeline && data.timeline.entry) || [];
    let added = 0;
    for (const entry of entries) {
      if (!entry || !entry.id || seen.has(entry.id)) continue;
      seen.add(entry.id);
      added++;
      if (seen.size >= limit.yahooEntries) return;
      extractYahooEntry(entry, self, inbound, events, avatars);
    }

    if (entries.length === 0) break;
    if (added === 0) break;
  }
}

function extractYahooEntry(entry, self, inbound, events, avatars) {
  const author = normalizeUsername(entry.screenName || usernameFromUrl(entry.userUrl || entry.url));
  if (entry.profileImage) setAvatar(avatars, author, entry.profileImage);

  if (inbound) {
    if (!author || author === self) return;
    const replyTargets = (entry.replyMentions || []).map((m) =>
      normalizeUsername(typeof m === 'string' ? m : m.screenName));

    const mentionTargets = [];
    for (const m of entry.mentions || []) {
      const name = normalizeUsername(m.screenName);
      if (name && name !== author) mentionTargets.push(name);
    }

    let type;
    let target = self;
    if (replyTargets.includes(self)) {
      type = 'reply';
    } else if (mentionTargets.includes(self)) {
      type = 'mention';
    } else {
      type = 'mention';
    }

    events.push({
      tweetId: entry.id,
      author,
      target,
      type,
      createdAt: yahooTimestamp(entry.createdAt)
    });
  } else {
    // Outbound: self tweet mentioning others.
    if (author !== self) return;
    const targets = new Set();
    for (const m of entry.mentions || []) {
      const name = normalizeUsername(m.screenName);
      if (name && name !== self) targets.add(name);
    }
    for (const target of targets) {
      events.push({
        tweetId: entry.id,
        author: self,
        target,
        type: 'mention',
        createdAt: yahooTimestamp(entry.createdAt)
      });
    }
  }
}

function usernameFromUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, 'https://x.com');
    if (!/(^|\.)(?:x|twitter)\.com$/i.test(url.hostname)) return '';
    return url.pathname.split('/').filter(Boolean)[0] || '';
  } catch (e) {
    return '';
  }
}

function yahooTimestamp(value) {
  if (!Number.isFinite(value)) return undefined;
  return value;
}

// ------------------------------------------------------------- fxtwitter ---

async function fxEvents(self, mode) {
  const limit = LIMITS[mode] || LIMITS.fast;
  const events = [];
  const avatars = {};
  const seen = new Set();

  await fxList(`${FX_API}/search?q=${encodeURIComponent('@' + self)}&feed=latest`, limit.fxPages, async (pagesDone, hasCursor) => {
    if (!hasCursor || pagesDone >= limit.fxPages) return true;
  }, (statuses) => {
    extractFxStatuses(statuses, self, 'inbound', events, avatars, seen);
  });

  await fxList(`${FX_API}/profile/${encodeURIComponent(self)}/statuses?with_replies=true`, limit.fxPages, async (pagesDone, hasCursor) => {
    if (!hasCursor || pagesDone >= limit.fxPages) return true;
  }, (statuses) => {
    extractFxStatuses(statuses, self, 'outbound', events, avatars, seen);
  });

  return { source: 'fxtwitter', events, avatars };
}

/**
 * Walks a fxtwitter list endpoint, calling `onPage` with each page's
 * statuses. onNext returns true to signal "stop early".
 */
async function fxList(baseUrl, maxPages, onNext, onPage) {
  let cursor = null;
  let pages = 0;
  let url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + `count=${FX_PAGE_SIZE}`;

  while (pages < maxPages) {
    const target = cursor ? url + '&cursor=' + encodeURIComponent(cursor) : url;
    let data;
    try {
      const res = await fetch(target, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12000)
      });
      if (!res.ok) throw new Error(`fxtwitter HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      throw new Error(`fxtwitter: ${e.message}`);
    }

    const statuses = (data && data.results) || [];
    onPage(statuses);
    pages++;

    cursor = data && data.cursor && data.cursor.bottom;
    if (pages >= maxPages) break;
    const stop = await onNext(pages, !!cursor);
    if (stop || !cursor || statuses.length === 0) break;
  }
}

function extractFxStatuses(statuses, self, direction, events, avatars, seen) {
  for (const status of statuses || []) {
    if (!status || !status.id || seen.has(status.id)) continue;
    seen.add(status.id);

    const author = normalizeUsername(status.author && status.author.screen_name);
    if (status.author && status.author.avatar_url) setAvatar(avatars, author, status.author.avatar_url);
    const rePoster = normalizeUsername(status.reposted_by && status.reposted_by.screen_name);
    if (status.reposted_by && status.reposted_by.avatar_url) setAvatar(avatars, rePoster, status.reposted_by.avatar_url);
    const replyTarget = normalizeUsername(status.replying_to && status.replying_to.screen_name);
    if (status.replying_to && status.replying_to.avatar_url) setAvatar(avatars, replyTarget, status.replying_to.avatar_url);
    const quoteAuthor = normalizeUsername(status.quote && status.quote.author && status.quote.author.screen_name);

    const mentions = mentionTargets(status);

    if (direction === 'inbound') {
      if (rePoster && rePoster !== self && author === self) {
        push(events, status, rePoster, self, 'repost');
      } else if (author && author !== self) {
        if (replyTarget === self) {
          push(events, status, author, self, 'reply');
        } else if (quoteAuthor === self) {
          push(events, status, author, self, 'quote');
        } else if (mentions.includes(self)) {
          push(events, status, author, self, 'mention');
        }
      }
    } else {
      if (author !== self) continue;
      if (replyTarget && replyTarget !== self) {
        push(events, status, self, replyTarget, 'reply');
      }
      for (const target of mentions) {
        if (target !== self) push(events, status, self, target, 'mention');
      }
      if (quoteAuthor && quoteAuthor !== self) {
        push(events, status, self, quoteAuthor, 'quote');
      }
    }
  }
}

function mentionTargets(status) {
  const targets = new Set();
  for (const facet of (status.raw_text && status.raw_text.facets) || []) {
    if (facet.type !== 'mention') continue;
    const target = normalizeUsername(facet.original || facet.replacement || facet.display || '');
    if (target) targets.add(target);
  }

  const text = (status.raw_text && status.raw_text.text) || status.text || '';
  for (const match of text.matchAll(/(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,15})\b/g)) {
    const target = normalizeUsername(match[2] || '');
    if (target) targets.add(target);
  }
  return [...targets];
}

function push(events, status, author, target, type) {
  if (!status.id || !author || !target || author === target) return;
  events.push({
    tweetId: status.id,
    author,
    target,
    type,
    createdAt: status.created_timestamp
  });
}

// ---------------------------------------------------------------- Bing ---

// Bing web search complements Yahoo worldwide: it indexes "@self" tweet
// pages on x.com over the last 7 days. Inbound mentions only.
export async function bingEvents(self, mode = 'fast') {
  const limit = LIMITS[mode] || LIMITS.fast;
  const seen = new Set();
  const events = [];

  for (let i = 0; i < limit.bingPages; i++) {
    const first = i * 10 + 1;
    const q = `"@${self}" site:x.com OR site:twitter.com`;
    const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&freshness=Week&first=${String(first)}&form=QBLH&mkt=en-US&cc=US&ensearch=1`;

    let html;
    try {
      const res = await fetch(url, { headers: BING_HEADERS, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
      html = await res.text();
    } catch (e) {
      if (i === 0) throw new Error(`bing: ${e.message}`);
      continue; // later pages failing is not fatal
    }

    const entries = parseBingHtml(html, self);
    let added = 0;
    for (const e of entries) {
      if (seen.has(e.tweetId)) continue;
      seen.add(e.tweetId);
      events.push({ tweetId: e.tweetId, author: e.screenName, target: self, type: 'mention', createdAt: undefined });
      added++;
    }
    if (added === 0 && i > 0) break;
    await sleep(400 + Math.floor(Math.random() * 400));
  }

  return { source: 'bing', events, avatars: {} };
}

function parseBingHtml(html, self) {
  const out = new Map();
  const scan = (text) => {
    TWEET_URL_RE.lastIndex = 0;
    let m;
    while ((m = TWEET_URL_RE.exec(text)) !== null) {
      const screenName = normalizeUsername(m[1]);
      const tweetId = m[2];
      if (!screenName || !tweetId || screenName === self || out.has(tweetId)) continue;
      out.set(tweetId, { tweetId, screenName });
    }
  };

  scan(html);

  // Redirected result links (bing.com/ck/a?...&u=a1<base64>) wrap the real
  // tweet URL; decode and scan those too.
  const ckRe = /href="(\/?ck\/a\?[^"?]+)"/gi;
  let cm;
  while ((cm = ckRe.exec(html)) !== null) {
    try {
      const u = '/ck/a?' === cm[1].slice(0, 6) ? cm[1] : cm[1];
      const params = new URLSearchParams('http://b.local' + u.replace(/^\/?ck\/a\?/, '?'));
      const raw = (params.get('u') || '').replace(/\s+/g, '');
      if (!/^a1/.test(raw)) continue;
      const b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const decoded = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4 || 0));
      scan(decoded);
    } catch (e) {
      continue;
    }
  }

  return [...out.values()];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- shared ---

export async function fetchSelfAvatar(screenName) {
  const url = `https://api.fxtwitter.com/${encodeURIComponent(normalizeUsername(screenName))}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 200 || !data.user || !data.user.avatar_url) return null;
    return upscaleTwitterAvatar(data.user.avatar_url);
  } catch (e) {
    return null;
  }
}

// Returns the profile's current follower count when the public profile
// endpoint exposes it. A missing count is non-fatal: collection can still
// proceed with the collector's bounded fallback behavior.
export async function fetchFollowerCount(screenName) {
  const normalized = normalizeUsername(screenName);
  if (!normalized) return null;

  const url = `https://api.fxtwitter.com/${encodeURIComponent(normalized)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const count = Number(data && data.user && data.user.followers);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
  } catch (e) {
    return null;
  }
}

function setAvatar(avatars, key, rawUrl) {
  if (!key || !rawUrl) return;
  const url = upscaleTwitterAvatar(rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl);
  if (!avatars[key]) avatars[key] = url;
}
