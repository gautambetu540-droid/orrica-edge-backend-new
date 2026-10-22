/**
 * Shared Indian Standard Time (Asia/Kolkata, UTC+05:30) Date and Weekday Formatter
 * Prevents date shifts across UTC/local timezone boundaries.
 */

export interface FormattedWalkInDate {
  dateStr: string;        // YYYY-MM-DD
  formattedDate: string;  // e.g. "Oct 19, 2026"
  weekday: string;        // e.g. "Mon"
  longWeekday: string;    // e.g. "Monday"
  displayDate: string;    // e.g. "Mon, Oct 19, 2026"
}

export function formatWalkInDate(input: string | Date | null | undefined): FormattedWalkInDate {
  if (!input) {
    return {
      dateStr: '',
      formattedDate: '',
      weekday: '',
      longWeekday: '',
      displayDate: '',
    };
  }

  // If input is a YYYY-MM-DD string (or starts with YYYY-MM-DD)
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      const year = parseInt(match[1], 10);
      const month = parseInt(match[2], 10) - 1;
      const day = parseInt(match[3], 10);

      // Create UTC date at noon (12:00:00) so no local offset anywhere on earth can shift the day
      const safeUtc = new Date(Date.UTC(year, month, day, 12, 0, 0));

      const weekday = safeUtc.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
      const longWeekday = safeUtc.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
      const formattedDate = safeUtc.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      });
      const dateStr = `${match[1]}-${match[2]}-${match[3]}`;

      return {
        dateStr,
        formattedDate,
        weekday,
        longWeekday,
        displayDate: `${weekday}, ${formattedDate}`,
      };
    }
  }

  // If input is Date or timestamp
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) {
    return {
      dateStr: String(input).slice(0, 10),
      formattedDate: String(input).slice(0, 10),
      weekday: '',
      longWeekday: '',
      displayDate: String(input).slice(0, 10),
    };
  }

  // Format in Asia/Kolkata timezone
  const kolkataDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d); // "YYYY-MM-DD"

  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
  }).format(d);

  const longWeekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
  }).format(d);

  const formattedDate = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);

  return {
    dateStr: kolkataDateStr,
    formattedDate,
    weekday,
    longWeekday,
    displayDate: `${weekday}, ${formattedDate}`,
  };
}


export function formatReadableInterviewDate(input: string | Date | null | undefined): string {
  const info = formatWalkInDate(input);
  if (!info.dateStr) return '';
  const parts = info.dateStr.split('-');
  if (parts.length !== 3) return info.displayDate || '';
  const [y, m, d] = parts.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
