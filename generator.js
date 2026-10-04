// FanOrbit generator: draws a concentric orbit avatar wall — the user's
// own avatar at the center, fans sorted by interaction score from the
// innermost ring outward, fans with no interaction data placed randomly
// among the outer rings.

(() => {
  const $ = (id) => document.getElementById(id);
  let currentBlob = null;

  document.addEventListener('DOMContentLoaded', () => {
    $('saveBtn').addEventListener('click', () => {
      if (currentBlob) downloadBlob(currentBlob);
    });
    $('againBtn').addEventListener('click', () => {
      run();
    });
    run();
  });

  async function run() {
    $('saveBtn').disabled = true;
    $('againBtn').disabled = true;
    $('preview').style.display = 'none';
    $('meta').textContent = '';
    setProgress(0);

    let stored;
    try {
      stored = await chrome.storage.local.get(['config', 'fansData', 'interactionData']);
    } catch (e) {
      setStatus('读取数据失败：' + ((e && e.message) || e));
      return;
    }

    const config = stored.config || {};
    const fansData = stored.fansData || { fans: [] };
    const interactionData = stored.interactionData || {};

    const avatarsExtra = interactionData.avatars || {};
    const fans = (fansData.fans || [])
      .map((f) => ({
        username: f.username,
        avatar: f.avatar || avatarsExtra[(f.username || '').toLowerCase()] || null,
        index: f.index || 0
      }))
      .filter((f) => f.avatar);
    if (!fans.length) {
      setStatus('没有可用的头像数据，请先开始粉丝采集。');
      return;
    }

    const scoreByName = interactionData.scoreByName || {};
    const ranked = [];
    const unranked = [];
    for (const fan of fans) {
      const s = scoreByName[fan.username.toLowerCase()];
      if (s && s.score > 0) ranked.push({ fan, score: s.score, count: s.interactionCount });
      else unranked.push(fan);
    }
    ranked.sort((a, b) => b.score - a.score || b.count - a.count || a.fan.index - b.fan.index);
    shuffle(unranked);

    const size = clampInt(config.avatarSize, 40, 300, 96);
    const bgColor = config.bgColor || '#f5f3ff';
    const titleRaw = config.titleText && config.titleText.trim() !== ''
      ? config.titleText
      : '恭喜我 {n} fo';

    setStatus('正在加载头像…');
    const loaded = await Downloader.download(fans, (p) => {
      setProgress(p.done / Math.max(1, p.total));
      setStatus(`正在加载头像 ${p.done}/${p.total}…`);
    });
    const ok = loaded.results.filter((x) => x && x.blob);
    if (!ok.length) {
      setStatus('头像加载失败，请检查网络后重新打开此页面。');
      return;
    }

    // Center avatar (echo the user's own avatar or a placeholder circle).
    let selfBlob = null;
    if (interactionData.selfAvatar) {
      selfBlob = await Downloader.fetchWithRetry(interactionData.selfAvatar, 2);
    }

    const ordered = buildOrderedItems(ranked, ok, unranked, ok);
    if (!ordered.length) {
      setStatus('没有可用的头像数据，请先开始粉丝采集。');
      return;
    }
    const blob = await drawOrbitFromItems(ordered, selfBlob, size, bgColor, titleRaw.replace('{n}', String(ordered.length)), `FanOrbit · X@${fansData.username || ''}`, config.dualSize !== false);
    if (!blob) {
      setStatus('图片生成失败。');
      return;
    }

    currentBlob = blob;
    const previewUrl = URL.createObjectURL(blob);
    $('preview').src = previewUrl;
    $('preview').style.display = 'block';
    $('saveBtn').disabled = false;
    $('againBtn').disabled = false;
    const scored = ranked.length;
    $('meta').textContent = `${ordered.length} 位粉丝 · 互动排序 ${scored} 位 · 随机 ${ordered.length - scored} 位 · ${size}px · JPEG 95%`;
    setProgress(1);
    setStatus('生成完成');

    autoDownload(blob);
  }

  // Place ranked fans first (innermost-out), then the shuffled no-data fans
  // in the remaining slots. Returns a flat list in slot order.
  function buildOrderedItems(ranked, okItems, unranked, okAll) {
    const byName = new Map();
    for (const item of okAll) byName.set(item.username.toLowerCase(), item);
    const out = [];
    for (const r of ranked) {
      const item = byName.get(r.fan.username.toLowerCase());
      if (item) out.push(item);
    }
    for (const fan of unranked) {
      const item = byName.get(fan.username.toLowerCase());
      if (item) out.push(item);
    }
    return out;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async function drawOrbitFromItems(items, selfBlob, size, bgColor, title, footer, dualSize) {
    const count = items.length;
    if (!count) return null;

    const gap = Math.max(6, Math.round(size * 0.12));
    // Two fixed tiers, not a gradual drain: the innermost BIG_RINGS rings
    // use bigSize, every ring after that stays at the plain avatar size.
    const BIG_RINGS = 3;
    const bigSize = dualSize ? Math.round(size * 1.4) : size;
    const centerR = Math.round(bigSize * 1.75);
    const pad = Math.round(size * 0.7);

    // Compute ring radii and capacities until all fans have a slot. Ring
    // radius r(k) is derived iteratively from the previous ring's own
    // diameter, so tier switches keep a constant gap everywhere.
    const rings = [];
    let available = 0;
    let k = 0;
    while (available < count && k < 200) {
      const s = dualSize && k < BIG_RINGS ? bigSize : size;
      const r = k === 0
        ? centerR + s / 2 + gap
        : rings[k - 1].radius + (rings[k - 1].size + s) / 2 + gap;
      const cap = Math.max(8, Math.floor((2 * Math.PI * r) / (s + gap)));
      rings.push({ radius: r, size: s, cap });
      available += cap;
      k++;
    }

    const last = rings[rings.length - 1];
    const maxR = last.radius + last.size / 2;
    const W = Math.ceil(2 * maxR + pad * 2);
    // Title band scales with the canvas width, not the avatar size — with
    // hundreds of fans the canvas gets very wide and a fixed band would
    // make the title unreadably small.
    const titleH = Math.max(Math.round(size * 0.6), Math.round(W * 0.045));
    const H = Math.ceil(W + titleH);

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const cy = titleH + maxR + pad / 2;

    // Slot ordering: ring by ring; fan index i goes to slot i. Each slot
    // carries its own tier size.
    const positions = [];
    for (const ring of rings) {
      const rotation = Math.random() * Math.PI * 2;
      const angleStep = (Math.PI * 2) / ring.cap;
      for (let i = 0; i < ring.cap; i++) {
        const angle = rotation + i * angleStep;
        positions.push({ x: cx + Math.cos(angle) * ring.radius, y: cy + Math.sin(angle) * ring.radius, s: ring.size });
      }
    }

    // Draw fans: items already ordered innermost-first.
    const bitmaps = [];
    for (const item of items) {
      try {
        bitmaps.push(await createImageBitmap(item.blob));
      } catch (e) {
        bitmaps.push(null);
      }
    }

    for (let i = 0; i < Math.min(items.length, positions.length); i++) {
      const bmp = bitmaps[i];
      const pos = positions[i];
      if (!bmp) continue;

      const drawRadius = pos.s / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, drawRadius, 0, Math.PI * 2);
      ctx.clip();
      const sw = bmp.width;
      const sh = bmp.height;
      const s = Math.min(sw, sh);
      ctx.drawImage(bmp, (sw - s) / 2, (sh - s) / 2, s, s, pos.x - drawRadius, pos.y - drawRadius, pos.s, pos.s);
      ctx.restore();
      ctx.lineWidth = Math.max(1, Math.round(pos.s * 0.02));
      ctx.strokeStyle = 'rgba(124, 58, 237, 0.35)';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, drawRadius, 0, Math.PI * 2);
      ctx.stroke();

      if (typeof bmp.close === 'function') bmp.close();
    }

    // Center avatar with a decorative double ring.
    const selfRadius = centerR;
    ctx.beginPath();
    ctx.arc(cx, cy, selfRadius + Math.round(bigSize * 0.06), 0, Math.PI * 2);
    ctx.fillStyle = '#7c3aed';
    ctx.fill();
    if (selfBlob) {
      try {
        const bmp = await createImageBitmap(selfBlob);
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, selfRadius, 0, Math.PI * 2);
        ctx.clip();
        const s = Math.min(bmp.width, bmp.height);
        ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, cx - selfRadius, cy - selfRadius, selfRadius * 2, selfRadius * 2);
        ctx.restore();
        if (typeof bmp.close === 'function') bmp.close();
      } catch (e) {
        drawPlaceholder(ctx, cx, cy, selfRadius);
      }
    } else {
      drawPlaceholder(ctx, cx, cy, selfRadius);
    }

    // Title + footer.
    const textColor = contrastColor(bgColor);
    const titleFont = Math.max(28, Math.round(W * 0.02));
    ctx.fillStyle = '#6d28d9';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${titleFont}px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.fillText(title, cx, titleH / 2 + titleFont / 2);
    const footFont = Math.max(18, Math.round(W * 0.012));
    ctx.fillStyle = textColor;
    ctx.font = `${footFont}px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.fillText(footer, cx, H - pad / 2);

    return new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.95);
    });
  }

  function drawPlaceholder(ctx, cx, cy, r) {
    ctx.fillStyle = '#7c3aed';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ede9fe';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(r * 0.9)}px -apple-system, "Segoe UI", sans-serif`;
    ctx.fillText('我', cx, cy);
  }

  function downloadBlob(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'FanOrbit.jpg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  function autoDownload(blob) {
    try {
      downloadBlob(blob);
    } catch (e) {
      // Blocked without user gesture; Save JPG remains available.
    }
  }

  function contrastColor(hex) {
    const { r, g, b } = parseHex(hex);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum > 150 ? '#0f172a' : '#ffffff';
  }

  function parseHex(hex) {
    let h = (hex || '').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h || 'f5f3ff', 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function setStatus(text) {
    $('status').textContent = text;
  }

  function setProgress(frac) {
    $('fill').style.width = Math.min(100, Math.round(frac * 100)) + '%';
  }

  function clampInt(v, min, max, def) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return def;
    return Math.min(max, Math.max(min, n));
  }
})();
