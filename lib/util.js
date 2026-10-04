// Small shared helpers for the service worker side.

export function normalizeUsername(raw) {
  return (raw || '').toString().replace(/^@/, '').trim().toLowerCase();
}

// Rewrites a Twitter profile image URL to the largest public variant.
export function upscaleTwitterAvatar(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('pbs.twimg.com') || !u.pathname.includes('/profile_images/')) {
      return url;
    }
    u.pathname = u.pathname
      .replace(/_normal(\.[a-z]+)$/i, '_400x400$1')
      .replace(/_mini(\.[a-z]+)$/i, '_400x400$1')
      .replace(/_bigger(\.[a-z]+)$/i, '_400x400$1')
      .replace(/_reasonably_small(\.[a-z]+)$/i, '_400x400$1')
      .replace(/_200x200(\.[a-z]+)$/i, '_400x400$1');
    return u.toString();
  } catch (e) {
    return url;
  }
}
