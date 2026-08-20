/**
 * Seed derivation (spec Part 3). Plain composite strings -- hashing into a
 * numeric PRNG seed only happens later, inside createLabeledStream.
 */

/**
 * Formats a Date's LOCAL year/month/day as 'YYYY-MM-DD'. Deliberately not
 * toISOString() (which is UTC and would flip the calendar day near midnight
 * in negative-UTC-offset timezones, breaking the "Tuesday is Tuesday"
 * promise). Pure: takes the Date as a parameter rather than reading the
 * system clock, so it's timezone-agnostic to test.
 */
export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Derives the day's world seed from a user id and a local calendar date. */
export function deriveWorldSeed(userId: string, localDate: string): string {
  return `${userId}::${localDate}`;
}

/** Derives a per-session seed from the day's world seed and a session index. */
export function deriveSessionSeed(
  worldSeed: string,
  sessionIndex: number,
): string {
  return `${worldSeed}::${sessionIndex}`;
}
