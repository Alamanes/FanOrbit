// FanOrbit generator: draws an orbit avatar wall — the user's own avatar
// at the center, fans sorted by interaction score from the innermost ring
// outward, fans with no interaction data placed randomly among the outer
// rings. Two layout shapes are supported: 圆形 (concentric rings) and 方形
// (square grid rings, the self avatar occupies the central 2x2 block). An
// optional 3-split mode cuts the finished image into 3 vertical strips for
// multi-image posts, with every cut line kept inside avatar-free corridors
// (the middle strip always keeps the whole center self avatar).

// split3 replaced the earlier split4 flag; fall back to the legacy key only
// when split3 was never written, so an explicit false is honored.
function split3Enabled(config) {
  return config.split3 !== undefined ? config.split3 === true : config.split4 === true;
}

(() => {
  const $ = (id) => document.getElementById(id);
  let currentBlob = null;
  let currentStrips = null;

  document.addEventListener('DOMContentLoaded', async () => {
    $('saveBtn').addEventListener('click', () => {
      if (currentStrips) downloadStrips(currentStrips);
      else if (currentBlob) downloadBlob(currentBlob);
    });
    $('againBtn').addEventListener('click', () => {
      run();
    });
    await initControls();
    run();
  });

  // Shape / split3 quick controls mirror the popup config, so the layout
  // can be tweaked right on this page without reopening the control panel.
  async function initControls() {
    let stored = {};
    try {
      stored = await chrome.storage.local.get('config');
    } catch (e) { /* keep defaults */ }
    const config = stored.config || {};
    $('shapeSel').value = config.shape === 'square' ? 'square' : 'circle';
    $('split3Chk').checked = split3Enabled(config);
    $('shapeSel').addEventListener('change', onControlChange);
    $('split3Chk').addEventListener('change', onControlChange);
  }

  async function onControlChange() {
    let stored = {};
    try {
      stored = await chrome.storage.local.get('config');
    } catch (e) { /* keep defaults */ }
    const config = {
      ...(stored.config || {}),
      shape: $('shapeSel').value === 'square' ? 'square' : 'circle',
      split3: $('split3Chk').checked
    };
    try {
      await chrome.storage.local.set({ config });
    } catch (e) { /* non-fatal; regenerate anyway */ }
    run();
  }

  async function run() {
    $('saveBtn').disabled = true;
    $('againBtn').disabled = true;
    $('preview').style.display = 'none';
    $('meta').textContent = '';
    setProgress(0);
    currentStrips = null;
    setControlsEnabled(false);

    let stored;
    try {
      stored = await chrome.storage.local.get(['config', 'fansData', 'interactionData']);
    } catch (e) {
      setStatus('读取数据失败：' + ((e && e.message) || e));
      setControlsEnabled(true);
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
      setControlsEnabled(true);
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
    const shape = config.shape === 'square' ? 'square' : 'circle';
    const split3 = split3Enabled(config);
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
      setControlsEnabled(true);
      return;
    }

    // Center avatar (echo the user's own avatar or a placeholder tile).
    let selfBlob = null;
    if (interactionData.selfAvatar) {
      selfBlob = await Downloader.fetchWithRetry(interactionData.selfAvatar, 2);
    }

    const ordered = buildOrderedItems(ranked, ok, unranked, ok);
    if (!ordered.length) {
      setStatus('没有可用的头像数据，请先开始粉丝采集。');
      setControlsEnabled(true);
      return;
    }
    const result = await drawOrbitFromItems(ordered, selfBlob, size, bgColor, titleRaw.replace('{n}', String(ordered.length)), `FanOrbit · X@${fansData.username || ''}`, {
      dualSize: config.dualSize !== false,
      colorSort: config.colorSort === true,
      shape,
      split3
    });
    if (!result) {
      setStatus('图片生成失败。');
      setControlsEnabled(true);
      return;
    }

    const { canvas, cuts } = result;
    const blob = await canvasToBlob(canvas);
    if (!blob) {
      setStatus('图片生成失败。');
      setControlsEnabled(true);
      return;
    }
    let strips = null;
    if (split3 && cuts) strips = await sliceStrips(canvas, cuts);

    currentBlob = blob;
    currentStrips = strips && cuts && strips.length === cuts.length + 1 ? strips : null;
    $('saveBtn').textContent = currentStrips ? `保存 ${currentStrips.length} 张分图` : '保存 JPG';
    const previewCanvas = currentStrips ? withCutGuides(canvas, cuts) : canvas;
    const previewBlob = currentStrips ? await canvasToBlob(previewCanvas) : blob;
    const previewUrl = URL.createObjectURL(previewBlob || blob);
    $('preview').src = previewUrl;
    $('preview').style.display = 'block';
    $('saveBtn').disabled = false;
    $('againBtn').disabled = false;
    setControlsEnabled(true);
    const scored = ranked.length;
    const parts = [
      `${ordered.length} 位粉丝`,
      shape === 'square' ? '方形网格' : '圆形同心环'
    ];
    if (config.colorSort === true) parts.push('颜色排序（彩虹环）');
    else parts.push(`互动排序 ${scored} 位 · 随机 ${ordered.length - scored} 位`);
    parts.push(`${size}px`);
    if (currentStrips) parts.push(`3分图（竖裁 ${currentStrips.length} 条，预览虚线为切割线）`);
    parts.push('JPEG 95%');
    $('meta').textContent = parts.join(' · ');
    setProgress(1);
    setStatus(currentStrips
      ? `生成完成，已下载 ${currentStrips.length} 张分图（若浏览器询问，请允许「下载多个文件」）`
      : '生成完成');

    autoDownload();
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

  async function drawOrbitFromItems(items, selfBlob, size, bgColor, title, footer, opts) {
    const count = items.length;
    if (!count) return null;
    const dualSize = opts.dualSize;
    const colorSort = opts.colorSort;
    const isSquare = opts.shape === 'square';
    const split3 = opts.split3 === true;

    const bitmaps = [];
    for (const item of items) {
      try {
        bitmaps.push(await createImageBitmap(item.blob));
      } catch (e) {
        bitmaps.push(null);
      }
    }

    // Pair every item with its bitmap before any reordering so both stay
    // aligned. With colorSort the hue order forms a smooth rainbow across
    // slots; low-detail hues (grayscale or unreadable pixels) go last.
    let entries = items.map((item, i) => ({ item, bitmap: bitmaps[i], hue: null }));
    if (colorSort) {
      for (const entry of entries) {
        if (!entry.bitmap) continue;
        entry.hue = bitmapHue(entry.bitmap);
      }
      entries = entries
        .map((e, i) => ({ e, i }))
        .sort((a, b) => (a.e.hue ?? 361) - (b.e.hue ?? 361) || a.i - b.i)
        .map((x) => x.e);
    }

    const gap = Math.max(6, Math.round(size * 0.12));
    // Two fixed tiers, not a gradual drain: the innermost BIG_RINGS rings
    // use bigSize, every ring after that stays at the plain avatar size.
    // Square grids read flatter than circles, so the tier contrast, center
    // clearance and frame are all stronger there to keep the core legible.
    const BIG_RINGS = 3;
    const bigSize = dualSize ? Math.round(size * (isSquare ? 1.55 : 1.4)) : size;
    // Extra margin between the center avatar and the first ring: the
    // decorative stroke below eats into the raw gap, without a margin the
    // nearest fans visually touch the purple center ring.
    const centerGap = Math.round(size * (isSquare ? 0.7 : 0.4));
    const decorR = Math.round(bigSize * (isSquare ? 0.1 : 0.06));
    // Extra spacing between the core (big) rings and the plain rings, so
    // the core circle reads as its own zone. Square layout only.
    const coreGap = isSquare && dualSize ? Math.round(size * 0.35) : 0;
    // Half-width of the center self block: a disc in circle mode, a 2x2
    // cell block (side 2*bigSize + gap) in square mode.
    const selfHalf = isSquare
      ? bigSize + Math.round(gap / 2)
      : Math.round(bigSize * 1.75);
    const pad = Math.round(size * 0.7);
    // Keep-out distance around each planned cut line: slots whose horizontal
    // extent comes this close to a cut are dropped, so no avatar is sliced.
    const cutMargin = Math.max(3, Math.round(size * 0.04));

    // Ring reach is the ring's center offset from the middle: a radius for
    // circles, a half side-length for squares. Ring k grows from ring k-1's
    // own diameter, so tier switches keep a constant gap everywhere.
    const rings = [];
    let positions = [];
    let W = 0, H = 0, cx = 0, cy = 0, titleH = 0, cuts = null;
    while (positions.length < count && rings.length < 200) {
      const prev = rings[rings.length - 1];
      const s = dualSize && rings.length < BIG_RINGS ? bigSize : size;
      const reach = prev
        ? prev.reach + (prev.size + s) / 2 + gap + (rings.length === BIG_RINGS ? coreGap : 0)
        : selfHalf + decorR + centerGap + s / 2 + gap;
      let cap;
      if (isSquare) {
        // Slots anchor at the four corners and space evenly along each
        // edge, so corner-adjacent pairs keep the full gap. Capacity is a
        // multiple of 4 to keep all four edges symmetric.
        const perEdge = Math.max(2, Math.floor((2 * reach) / (s + gap)));
        cap = perEdge * 4;
      } else {
        cap = Math.max(8, Math.floor((2 * Math.PI * reach) / (s + gap)));
      }
      rings.push({ reach, size: s, cap });

      const orbitR = reach + s / 2;
      W = Math.ceil(2 * orbitR + pad * 2);
      // Title band scales with the canvas width, not the avatar size — with
      // hundreds of fans the canvas gets very wide and a fixed band would
      // make the title unreadably small.
      titleH = Math.max(Math.round(size * 0.6), Math.round(W * 0.045));
      H = Math.ceil(W + titleH);
      cx = W / 2;
      cy = titleH + orbitR + pad / 2;
      cuts = split3 ? planCuts(W, cx, selfHalf + decorR, cutMargin) : null;

      // Regenerate all slot positions against the latest canvas size: the
      // cut corridors depend on W, and every slot must clear the final cuts.
      positions = [];
      for (const ring of rings) {
        if (isSquare) {
          // Walk slot indexes around the perimeter (top edge left→right,
          // then right, bottom, left); slot 0 of each edge sits exactly on
          // the corner. A random whole-slot shift rotates the pattern.
          const perEdge = ring.cap / 4;
          const h = ring.reach;
          const step = (2 * h) / perEdge;
          const shift = Math.floor(Math.random() * ring.cap);
          for (let i = 0; i < ring.cap; i++) {
            const idx = (i + shift) % ring.cap;
            const edge = Math.floor(idx / perEdge);
            const d = (idx % perEdge) * step;
            let x, y;
            if (edge === 0) { x = -h + d; y = -h; }
            else if (edge === 1) { x = h; y = -h + d; }
            else if (edge === 2) { x = h - d; y = h; }
            else { x = -h; y = h - d; }
            positions.push({ x: cx + x, y: cy + y, s: ring.size });
          }
        } else {
          const rotation = Math.random() * Math.PI * 2;
          const angleStep = (Math.PI * 2) / ring.cap;
          for (let i = 0; i < ring.cap; i++) {
            const angle = rotation + i * angleStep;
            positions.push({ x: cx + Math.cos(angle) * ring.reach, y: cy + Math.sin(angle) * ring.reach, s: ring.size });
          }
        }
      }
      if (cuts) {
        positions = positions.filter((p) => !cuts.some((c) => Math.abs(p.x - c) < p.s / 2 + cutMargin));
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    // Core-zone halo: a soft tinted rounded square behind the big rings
    // (plus a faint outline) so the inner circle reads as a distinct zone.
    if (isSquare && dualSize && rings.length) {
      const coreIdx = Math.min(BIG_RINGS, rings.length) - 1;
      const coreHalf = rings[coreIdx].reach + rings[coreIdx].size / 2 + Math.round(coreGap * 0.5 + gap * 0.5);
      ctx.beginPath();
      roundedRect(ctx, cx - coreHalf, cy - coreHalf, coreHalf * 2, coreHalf * 2, Math.round(size * 0.45));
      ctx.fillStyle = 'rgba(124, 58, 237, 0.055)';
      ctx.fill();
      ctx.lineWidth = Math.max(2, Math.round(size * 0.025));
      ctx.strokeStyle = 'rgba(124, 58, 237, 0.16)';
      ctx.stroke();
    }

    // Draw fans: slots are ring-ordered, entries carry the final order.
    for (let i = 0; i < Math.min(entries.length, positions.length); i++) {
      const bmp = entries[i].bitmap;
      const pos = positions[i];
      if (!bmp) continue;

      const drawRadius = pos.s / 2;
      ctx.save();
      ctx.beginPath();
      slotPath(ctx, pos.x, pos.y, pos.s, isSquare);
      ctx.clip();
      const sw = bmp.width;
      const sh = bmp.height;
      const s = Math.min(sw, sh);
      ctx.drawImage(bmp, (sw - s) / 2, (sh - s) / 2, s, s, pos.x - drawRadius, pos.y - drawRadius, pos.s, pos.s);
      ctx.restore();
      ctx.lineWidth = Math.max(1, Math.round(pos.s * 0.02));
      ctx.strokeStyle = isSquare ? 'rgba(124, 58, 237, 0.22)' : 'rgba(124, 58, 237, 0.35)';
      ctx.beginPath();
      slotPath(ctx, pos.x, pos.y, pos.s, isSquare);
      ctx.stroke();

      if (typeof bmp.close === 'function') bmp.close();
    }

    // Center avatar with a decorative border (disc or rounded square).
    if (isSquare) {
      const selfSide = selfHalf * 2;
      ctx.beginPath();
      roundedRect(ctx, cx - selfHalf - decorR, cy - selfHalf - decorR, selfSide + decorR * 2, selfSide + decorR * 2, Math.round(selfSide * 0.24));
      ctx.fillStyle = '#7c3aed';
      ctx.fill();
      // White inner ring between the purple frame and the avatar, so the
      // center block pops out of the surrounding avatar grid.
      const inner = selfHalf + Math.round(decorR * 0.45);
      ctx.beginPath();
      roundedRect(ctx, cx - inner, cy - inner, inner * 2, inner * 2, Math.round(selfSide * 0.2));
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      if (selfBlob) {
        try {
          const bmp = await createImageBitmap(selfBlob);
          ctx.save();
          ctx.beginPath();
          roundedRect(ctx, cx - selfHalf, cy - selfHalf, selfSide, selfSide, Math.round(selfSide * 0.18));
          ctx.clip();
          const s = Math.min(bmp.width, bmp.height);
          ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, cx - selfHalf, cy - selfHalf, selfSide, selfSide);
          ctx.restore();
          if (typeof bmp.close === 'function') bmp.close();
        } catch (e) {
          drawPlaceholder(ctx, cx, cy, selfHalf, true);
        }
      } else {
        drawPlaceholder(ctx, cx, cy, selfHalf, true);
      }
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, selfHalf + decorR, 0, Math.PI * 2);
      ctx.fillStyle = '#7c3aed';
      ctx.fill();
      if (selfBlob) {
        try {
          const bmp = await createImageBitmap(selfBlob);
          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, cy, selfHalf, 0, Math.PI * 2);
          ctx.clip();
          const s = Math.min(bmp.width, bmp.height);
          ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, cx - selfHalf, cy - selfHalf, selfHalf * 2, selfHalf * 2);
          ctx.restore();
          if (typeof bmp.close === 'function') bmp.close();
        } catch (e) {
          drawPlaceholder(ctx, cx, cy, selfHalf, false);
        }
      } else {
        drawPlaceholder(ctx, cx, cy, selfHalf, false);
      }
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

    return { canvas, cuts };
  }

  // Two vertical cut lines near the third marks, producing 3 strips whose
  // middle one keeps the whole center self avatar. Cuts may not slice the
  // self block: a cut falling inside the block's forbidden zone (L, R)
  // snaps to the nearer zone edge, and the spacing passes below jump
  // across the zone whenever a min-width push would land inside it.
  // The strips still tile the full image, only their widths may differ.
  function planCuts(W, cx, selfExtentHalf, m) {
    const L = Math.round(cx - selfExtentHalf - m - 1);
    const R = Math.round(cx + selfExtentHalf + m + 1);
    const inZone = (c) => c > L && c < R;
    const snap = (q) => {
      if (!inZone(q)) return q;
      return q - L <= R - q ? L : R;
    };
    const minStrip = Math.max(Math.round(W * 0.08), 40);
    const cuts = [1 / 3, 2 / 3].map((f) => snap(Math.round(W * f)));
    // Forward pass: strictly increasing with a minimum strip width.
    for (let i = 1; i < cuts.length; i++) {
      cuts[i] = Math.max(cuts[i], cuts[i - 1] + minStrip);
      if (inZone(cuts[i])) cuts[i] = R;
      cuts[i] = Math.max(cuts[i], cuts[i - 1] + minStrip);
    }
    // Backward pass: clamp to the canvas edge and to the next cut.
    for (let i = cuts.length - 1; i >= 0; i--) {
      const hi = i === cuts.length - 1 ? W - m - 1 : cuts[i + 1] - minStrip;
      cuts[i] = Math.min(cuts[i], hi);
      if (inZone(cuts[i])) cuts[i] = L;
    }
    // Final forward guard against the backward pass pulling cuts together.
    for (let i = 0; i < cuts.length; i++) {
      const lo = i === 0 ? m + 1 : cuts[i - 1] + minStrip;
      cuts[i] = Math.max(cuts[i], lo);
      if (inZone(cuts[i])) cuts[i] = R;
    }
    return cuts;
  }

  function slotPath(ctx, x, y, s, isSquare) {
    if (isSquare) {
      roundedRect(ctx, x - s / 2, y - s / 2, s, s, Math.max(4, Math.round(s * 0.18)));
    } else {
      ctx.arc(x, y, s / 2, 0, Math.PI * 2);
    }
  }

  function roundedRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Slice the finished canvas into vertical strips along the cut lines.
  async function sliceStrips(canvas, cuts) {
    const xs = [0, ...cuts, canvas.width];
    const out = [];
    for (let i = 0; i < xs.length - 1; i++) {
      const w = xs[i + 1] - xs[i];
      if (w < 1) return null;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = canvas.height;
      const g = c.getContext('2d');
      g.drawImage(canvas, xs[i], 0, w, canvas.height, 0, 0, w, canvas.height);
      const b = await canvasToBlob(c);
      if (!b) return null;
      out.push(b);
    }
    return out;
  }

  // Preview-only copy with dashed guide lines at the cut positions.
  function withCutGuides(canvas, cuts) {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const g = c.getContext('2d');
    g.drawImage(canvas, 0, 0);
    const dash = Math.max(8, Math.round(canvas.height * 0.012));
    g.setLineDash([dash, dash]);
    g.lineWidth = Math.max(2, Math.round(canvas.width * 0.002));
    g.strokeStyle = 'rgba(124, 58, 237, 0.85)';
    for (const x of cuts) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, canvas.height);
      g.stroke();
    }
    return c;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.95);
    });
  }

  // Average color of a bitmap as an HSL hue in [0, 360). Nearly
  // unfollowable pixels (fully faded or grayscale) return a sentinel past
  // the hue range so they sort to the outer end of the rainbow.
  function bitmapHue(bitmap) {
    const n = 24;
    const box = document.createElement('canvas');
    box.width = n;
    box.height = n;
    const g = box.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0, n, n);
    let data;
    try {
      data = g.getImageData(0, 0, n, n).data;
    } catch (e) {
      return null;
    }
    let r = 0, gr = 0, b = 0, a = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3] / 255;
      if (alpha < 0.5) continue;
      r += data[i] * alpha;
      gr += data[i + 1] * alpha;
      b += data[i + 2] * alpha;
      a += alpha;
    }
    if (!a) return null;
    return rgbToHue(r / a, gr / a, b / a);
  }

  function rgbToHue(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d < 14) return 361;
    if (max === r) return ((g - b) / d % 6 + 6) % 6 * 60;
    if (max === g) return ((b - r) / d + 2) * 60;
    return ((r - g) / d + 4) * 60;
  }

  function drawPlaceholder(ctx, cx, cy, r, isSquare) {
    ctx.fillStyle = '#7c3aed';
    ctx.beginPath();
    if (isSquare) {
      roundedRect(ctx, cx - r, cy - r, r * 2, r * 2, Math.round(r * 0.36));
    } else {
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = '#ede9fe';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(r * 0.9)}px -apple-system, "Segoe UI", sans-serif`;
    ctx.fillText('我', cx, cy);
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'FanOrbit.jpg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  // Stagger strip downloads so Chrome does not coalesce or drop them.
  function downloadStrips(blobs) {
    blobs.forEach((b, i) => {
      setTimeout(() => downloadBlob(b, `FanOrbit-${i + 1}.jpg`), i * 400);
    });
  }

  function autoDownload() {
    try {
      if (currentStrips) downloadStrips(currentStrips);
      else if (currentBlob) downloadBlob(currentBlob);
    } catch (e) {
      // Blocked without user gesture; the save button remains available.
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

  function setControlsEnabled(enabled) {
    $('shapeSel').disabled = !enabled;
    $('split3Chk').disabled = !enabled;
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
