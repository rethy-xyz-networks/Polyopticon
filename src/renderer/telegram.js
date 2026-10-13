// Public Telegram channels as tabs in the story pane (the ✈️ button): Telegram's own web
// view of a channel, https://t.me/s/<name>/. Pure helpers; the tab itself is in tabs.js.

/** "durov", "@durov", "t.me/durov", "https://t.me/s/durov/123?x" -> "durov"; null if it can't be a channel. */
export function parseTelegramChannel(text) {
  const c = String(text).trim()
    .replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//i, '')
    .replace(/^s\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
  return /^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(c) ? c : null;
}

/** The public web view of a channel. */
export const telegramUrl = name => `https://t.me/s/${name}/`;

/** The channel a t.me URL shows (null for any other page). */
export function telegramChannelOf(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 't.me') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    return parseTelegramChannel(parts[0] === 's' ? parts[1] ?? '' : parts[0] ?? '');
  } catch { return null; }
}
