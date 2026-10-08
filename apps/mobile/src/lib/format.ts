const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days between two timestamps in local time (0 = same day). */
export function calendarDaysBetween(earlier: number, later: number): number {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / DAY);
}

export function formatTime(ts: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(ts);
}

/** Chat list timestamp: "9:41 AM", "Yesterday", "Tuesday", or "10/2/26". */
export function formatConversationTime(ts: number, now = Date.now(), locale?: string): string {
  const days = calendarDaysBetween(ts, now);
  if (days <= 0) return formatTime(ts, locale);
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(ts);
  return new Intl.DateTimeFormat(locale, {
    year: '2-digit',
    month: 'numeric',
    day: 'numeric',
  }).format(ts);
}

/** Divider between days in a conversation: "Today", "Yesterday", "Monday, Oct 6". */
export function formatDayDivider(ts: number, now = Date.now(), locale?: string): string {
  const days = calendarDaysBetween(ts, now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(ts);
}

/** Running timer format: "0:07", "12:05", "1:02:03". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Human call length for history rows: "45 sec", "12 min", "1 hr 5 min". */
export function formatCallLength(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} sec`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} hr ${rem} min` : `${h} hr`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Presence line under a contact's name. */
export function formatLastSeen(ts: number | undefined, now = Date.now(), locale?: string): string {
  if (ts === undefined) return 'last seen recently';
  const minutes = Math.floor((now - ts) / 60_000);
  if (minutes < 1) return 'last seen just now';
  if (minutes < 60) return `last seen ${minutes} min ago`;
  const days = calendarDaysBetween(ts, now);
  if (days === 0) return `last seen today at ${formatTime(ts, locale)}`;
  if (days === 1) return `last seen yesterday at ${formatTime(ts, locale)}`;
  return 'last seen recently';
}
