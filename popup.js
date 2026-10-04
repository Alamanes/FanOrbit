(() => {
  const $ = (id) => document.getElementById(id);

  const DEFAULT_CONFIG = {
    username: '',
    maxCount: 'all',
    avatarSize: 96,
    bgColor: '#f5f3ff',
    titleText: '',
    scanMode: 'fast',
    dualSize: true,
    colorSort: false
  };

  document.addEventListener('DOMContentLoaded', async () => {
    const { config } = await chrome.storage.local.get('config');
    const c = { ...DEFAULT_CONFIG, ...(config || {}) };
    $('username').value = c.username || '';
    $('maxCount').value = c.maxCount === 'all' ? '' : c.maxCount;
    $('avatarSize').value = c.avatarSize;
    $('bgColor').value = c.bgColor;
    $('titleText').value = c.titleText || '';
    $('scanMode').value = c.scanMode || 'fast';
    $('dualSize').checked = c.dualSize !== false;
    $('colorSort').checked = c.colorSort === true;

    $('startBtn').addEventListener('click', start);
    $('genBtn').addEventListener('click', openGen);

    chrome.storage.onChanged.addListener(updateFromStorage);
    refreshStatus();
  });

  async function collectConfig() {
    const stored = await chrome.storage.local.get('config');
    const config = {
      ...(stored.config || {}),
      ...DEFAULT_CONFIG,
      username: $('username').value.trim().replace(/^@/, ''),
      maxCount: $('maxCount').value === '' ? 'all' : String($('maxCount').value),
      avatarSize: clampInt($('avatarSize').value, 40, 300, 96),
      bgColor: $('bgColor').value || '#f5f3ff',
      titleText: $('titleText').value.trim(),
      scanMode: $('scanMode').value,
      dualSize: $('dualSize').checked,
      colorSort: $('colorSort').checked
    };
    await chrome.storage.local.set({ config });
    return config;
  }

  async function start() {
    const config = await collectConfig();
    if (!config.username) {
      $('status').textContent = '请先输入 X 用户名';
      return;
    }
    $('startBtn').disabled = true;
    $('status').textContent = '已开始，正在打开粉丝页…';
    chrome.runtime.sendMessage({ type: 'START' });
  }

  async function openGen() {
    chrome.runtime.sendMessage({ type: 'GEN_OPEN' });
  }

  async function refreshStatus() {
    const stored = await chrome.storage.local.get();
    updateFromStorage({
      config: { newValue: stored.config },
      progress: { newValue: stored.progress },
      fansData: { newValue: stored.fansData },
      interactionData: { newValue: stored.interactionData }
    });
  }

  function updateFromStorage(changes) {
    if (changes.progress) {
      const p = changes.progress.newValue || {};
      $('status').textContent = p.message || '待开始';
      const frac = p.max > 0 ? Math.min(1, (p.current || 0) / p.max) : 0;
      $('fill').style.width = Math.round(frac * 100) + '%';
    }
    if (changes.fansData || changes.interactionData) {
      chrome.storage.local.get(['fansData', 'interactionData']).then((s) => {
        const fans = (s.fansData && s.fansData.total) || 0;
        const scored = s.interactionData ? Object.keys(s.interactionData.scores || {}).length : 0;
        $('meta').textContent = `粉丝 ${fans} 位 · 有效互动 ${scored} 位`;
      });
    }
  }

  function clampInt(v, min, max, def) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return def;
    return Math.min(max, Math.max(min, n));
  }
})();
