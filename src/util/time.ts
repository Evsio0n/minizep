/** The zone dates are read and shown in: MINIZEP_TIMEZONE, else the process's zone. */
export function displayTimeZone(): string {
  return process.env.MINIZEP_TIMEZONE ?? localTimeZone();
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * "2026-03-01": the calendar day of `d` in `timeZone`. The extraction LLM
 * resolves dates in that zone, so slicing the UTC ISO string would show the
 * day before for anything east of UTC.
 */
export function calendarDay(d: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
