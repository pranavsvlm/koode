import {
  calendarDaysBetween,
  formatCallLength,
  formatConversationTime,
  formatDayDivider,
  formatDuration,
  formatFileSize,
  formatLastSeen,
} from '../format';

// Fixed local-time "now": Thursday 9 October 2026, 14:30.
const now = new Date(2026, 9, 9, 14, 30).getTime();
const at = (d: number, h = 9, m = 0) => new Date(2026, 9, d, h, m).getTime();

describe('calendar helpers', () => {
  it('counts calendar days, not 24h windows', () => {
    expect(calendarDaysBetween(new Date(2026, 9, 8, 23, 59).getTime(), at(9, 0, 1))).toBe(1);
    expect(calendarDaysBetween(at(9, 1), now)).toBe(0);
  });
});

describe('formatConversationTime', () => {
  it('shows a time for today', () => {
    expect(formatConversationTime(at(9, 9, 41), now, 'en-US')).toBe('9:41 AM');
  });
  it('shows Yesterday', () => {
    expect(formatConversationTime(at(8), now, 'en-US')).toBe('Yesterday');
  });
  it('shows the weekday within the last week', () => {
    expect(formatConversationTime(at(6), now, 'en-US')).toBe('Tuesday');
  });
  it('shows a short date for older messages', () => {
    expect(formatConversationTime(at(1), now, 'en-US')).toBe('10/1/26');
  });
});

describe('formatDayDivider', () => {
  it('labels today and yesterday', () => {
    expect(formatDayDivider(at(9), now, 'en-US')).toBe('Today');
    expect(formatDayDivider(at(8), now, 'en-US')).toBe('Yesterday');
  });
  it('uses weekday and date, adding the year only when different', () => {
    expect(formatDayDivider(at(5), now, 'en-US')).toBe('Monday, Oct 5');
    expect(formatDayDivider(new Date(2025, 11, 31).getTime(), now, 'en-US')).toBe(
      'Wednesday, Dec 31, 2025',
    );
  });
});

describe('durations and sizes', () => {
  it.each([
    [7, '0:07'],
    [725, '12:05'],
    [3723, '1:02:03'],
    [-3, '0:00'],
  ])('formatDuration(%i) = %s', (s, expected) => {
    expect(formatDuration(s)).toBe(expected);
  });

  it.each([
    [45, '45 sec'],
    [312, '5 min'],
    [3900, '1 hr 5 min'],
    [7200, '2 hr'],
  ])('formatCallLength(%i) = %s', (s, expected) => {
    expect(formatCallLength(s)).toBe(expected);
  });

  it.each([
    [512, '512 B'],
    [482_000, '471 KB'],
    [2_500_000, '2.4 MB'],
  ])('formatFileSize(%i) = %s', (b, expected) => {
    expect(formatFileSize(b)).toBe(expected);
  });
});

describe('formatLastSeen', () => {
  it('describes recency', () => {
    expect(formatLastSeen(now - 20_000, now)).toBe('last seen just now');
    expect(formatLastSeen(now - 12 * 60_000, now)).toBe('last seen 12 min ago');
    expect(formatLastSeen(at(9, 8, 5), now, 'en-US')).toBe('last seen today at 8:05 AM');
    expect(formatLastSeen(at(8, 20, 0), now, 'en-US')).toBe('last seen yesterday at 8:00 PM');
    expect(formatLastSeen(undefined, now)).toBe('last seen recently');
  });
});
