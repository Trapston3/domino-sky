const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeString(hhmm: string): boolean {
  return TIME_PATTERN.test(hhmm);
}

export function parseTimeToMinutes(hhmm: string): number {
  const match = TIME_PATTERN.exec(hhmm);
  if (!match) {
    throw new Error(`Invalid HH:MM time string: "${hhmm}"`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

export function formatMinutesToTime(minutes: number): string {
  const dayOffset = Math.floor(minutes / 1440);
  const inDay = ((minutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(inDay / 60)).padStart(2, '0');
  const mm = String(inDay % 60).padStart(2, '0');
  if (dayOffset > 0) {
    return `${hh}:${mm} (+${dayOffset})`;
  }
  return `${hh}:${mm}`;
}

export function formatDeltaMinutes(minutes: number): string {
  if (minutes === 0) return '0m';
  const sign = minutes > 0 ? '+' : '';
  return `${sign}${minutes}m`;
}
