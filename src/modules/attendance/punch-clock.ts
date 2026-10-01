/** Biometric clock runs ahead of civil time — subtract before attendance math. */
export const PUNCH_CLOCK_SKEW_MINUTES = 9;

/** Minimum late / duration grace for every shift (minutes). */
export const DEFAULT_GRACE_MINUTES = 15;

/**
 * Bump when deriveAttendance / proposeLop / skew / grace / permission credit change.
 * Open imports refresh once when rules_version is behind this value.
 */
export const ATTENDANCE_RULES_VERSION = 4;

export function effectiveGraceMinutes(shiftGracePeriodMinutes: number): number {
  return Math.max(shiftGracePeriodMinutes, DEFAULT_GRACE_MINUTES);
}

/** Machine is fast: real punch is earlier than the logged time. */
export function adjustPunchClock(value: Date | null, skewMinutes = PUNCH_CLOCK_SKEW_MINUTES): Date | null {
  if (!value) return null;
  return new Date(value.getTime() - skewMinutes * 60_000);
}
