/** Cap leftover balance by policy carry-forward limit. Excess expires. */
export function computeCarryForward(available: number, maxCarry: number): number {
  return Math.min(Math.max(0, available), Math.max(0, maxCarry));
}

export function previousPeriod(period: string): string {
  const year = Number(period);
  if (!Number.isInteger(year)) {
    throw new Error(`Invalid allocation period: ${period}`);
  }
  return String(year - 1);
}
