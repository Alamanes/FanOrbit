// Interaction scoring: converts raw interaction events into a per-fan
// ranking. Weighting scheme follows the public method used by NekoCircle
// (https://github.com/acnekot/NekoCircle), reimplemented independently.

export const TYPE_WEIGHTS = { reply: 1, quote: 0.8, mention: 0.6, repost: 0.4 };

// Inbound interactions (the fan reaching out) matter more than outbound.
export const INBOUND_DIRECTION_WEIGHT = 1.5;
export const OUTBOUND_DIRECTION_WEIGHT = 0.5;

const LATEST_WINDOW_DAYS = 2;
const BOOSTED_WINDOW_END_DAYS = 5;
const BOOSTED_WINDOW_WEIGHT = 0.95;
const OLDER_DECAY_DAYS = 15;

function normalizeTs(ms) {
  return ms < 1_000_000_000_000 ? ms * 1000 : ms;
}

export function timeWeight(createdAt, now = Date.now()) {
  if (!createdAt || !Number.isFinite(createdAt)) return 1;
  const daysAgo = Math.max(0, now - normalizeTs(createdAt)) / 86_400_000;
  if (daysAgo <= LATEST_WINDOW_DAYS) return 1;
  if (daysAgo <= BOOSTED_WINDOW_END_DAYS) return BOOSTED_WINDOW_WEIGHT;
  return BOOSTED_WINDOW_WEIGHT * Math.exp(-(daysAgo - BOOSTED_WINDOW_END_DAYS) / OLDER_DECAY_DAYS);
}

function newEntry() {
  return {
    screenName: '',
    inbound: 0,
    outbound: 0,
    inboundCount: 0,
    outboundCount: 0,
    score: 0
  };
}

// events: { author, target, type, createdAt }
export function computeScores(events, selfLower) {
  const byUser = new Map();

  for (const ev of events || []) {
    const author = normalize(ev.author);
    const target = normalize(ev.target);
    if (!author || !target || author === target) continue;
    const type = TYPE_WEIGHTS[ev.type] != null ? ev.type : 'mention';
    const w = TYPE_WEIGHTS[type] * timeWeight(ev.createdAt);

    if (target === selfLower) {
      // Fan -> self
      const e = byUser.get(author) || { ...newEntry(), screenName: author };
      e.inbound += w;
      e.inboundCount += 1;
      byUser.set(author, e);
    } else if (author === selfLower) {
      // Self -> fan
      const e = byUser.get(target) || { ...newEntry(), screenName: target };
      e.outbound += w;
      e.outboundCount += 1;
      byUser.set(target, e);
    }
  }

  const scores = [];
  for (const e of byUser.values()) {
    const total = e.inbound + e.outbound;
    const balance = total > 0 ? (2 * Math.min(e.inbound, e.outbound)) / total : 0;
    const base = e.inbound * INBOUND_DIRECTION_WEIGHT + e.outbound * OUTBOUND_DIRECTION_WEIGHT;
    e.score = Math.round(base * (0.7 + 0.3 * balance) * 1000) / 1000;
    e.interactionCount = e.inboundCount + e.outboundCount;
    scores.push(e);
  }
  scores.sort((a, b) => b.score - a.score || b.interactionCount - a.interactionCount || a.screenName.localeCompare(b.screenName));
  return scores;
}

function normalize(raw) {
  return (raw || '').toString().replace(/^@/, '').trim().toLowerCase();
}
