/**
 * Pure YTD helpers for the Sandip payslip playground (Phase 5).
 * Apr → month before playground period, published slips only.
 */

import { roundMoney } from './calc';
import { periodsInFyBefore } from './new-regime-tax';

export type YtdSlipComponents = {
  period: string;
  basic: number;
  da: number;
  hra: number;
  fuel: number;
  incentives: number;
  other: number;
  professionalTax: number;
  tds: number;
  employeeWelfare: number;
  otherDeductions: number;
  lopAmount: number;
  gross: number;
};

export type PlaygroundYtdTotals = {
  basic: number;
  da: number;
  hra: number;
  fuel: number;
  incentives: number;
  other: number;
  professionalTax: number;
  tds: number;
  employeeWelfare: number;
  otherDeductions: number;
  lopAmount: number;
  gross: number;
  earnings: number;
  slipCount: number;
  periods: string[];
};

export function emptyYtdTotals(): PlaygroundYtdTotals {
  return {
    basic: 0,
    da: 0,
    hra: 0,
    fuel: 0,
    incentives: 0,
    other: 0,
    professionalTax: 0,
    tds: 0,
    employeeWelfare: 0,
    otherDeductions: 0,
    lopAmount: 0,
    gross: 0,
    earnings: 0,
    slipCount: 0,
    periods: [],
  };
}

/** YYYY-MM from a YYYY-MM-DD (or YYYY-MM) joining date. */
export function joiningPeriodFromDate(joiningDate: string | null | undefined): string | null {
  if (!joiningDate) return null;
  const trimmed = joiningDate.trim();
  const match = /^(\d{4})-(\d{2})/.exec(trimmed);
  if (!match) return null;
  return `${match[1]}-${match[2]}`;
}

/**
 * FY periods that should contribute to YTD for the playground month:
 * Apr → month before `playgroundPeriod`, on/after joining period when provided.
 */
export function expectedYtdPeriods(
  playgroundPeriod: string,
  joiningPeriod: string | null = null,
): string[] {
  const prior = periodsInFyBefore(playgroundPeriod);
  if (!joiningPeriod) return prior;
  return prior.filter((period) => period >= joiningPeriod);
}

/** Published slips whose period is in the expected YTD window. */
export function filterSlipsForYtd<T extends { period: string }>(
  slips: T[],
  playgroundPeriod: string,
  joiningPeriod: string | null = null,
): T[] {
  const allowed = new Set(expectedYtdPeriods(playgroundPeriod, joiningPeriod));
  return slips.filter((slip) => allowed.has(slip.period));
}

export function sumYtdFromSlips(slips: YtdSlipComponents[]): PlaygroundYtdTotals {
  const ytd = emptyYtdTotals();
  const periods: string[] = [];
  for (const slip of slips) {
    ytd.basic = roundMoney(ytd.basic + slip.basic);
    ytd.da = roundMoney(ytd.da + slip.da);
    ytd.hra = roundMoney(ytd.hra + slip.hra);
    ytd.fuel = roundMoney(ytd.fuel + slip.fuel);
    ytd.incentives = roundMoney(ytd.incentives + slip.incentives);
    ytd.other = roundMoney(ytd.other + slip.other);
    ytd.professionalTax = roundMoney(ytd.professionalTax + slip.professionalTax);
    ytd.tds = roundMoney(ytd.tds + slip.tds);
    ytd.employeeWelfare = roundMoney(ytd.employeeWelfare + slip.employeeWelfare);
    ytd.otherDeductions = roundMoney(ytd.otherDeductions + slip.otherDeductions);
    ytd.lopAmount = roundMoney(ytd.lopAmount + slip.lopAmount);
    ytd.gross = roundMoney(ytd.gross + slip.gross);
    ytd.earnings = roundMoney(
      ytd.earnings +
        slip.basic +
        slip.da +
        slip.hra +
        slip.fuel +
        slip.incentives +
        slip.other -
        slip.lopAmount,
    );
    ytd.slipCount += 1;
    periods.push(slip.period);
  }
  ytd.periods = [...new Set(periods)].sort();
  return ytd;
}

/** Expected YTD months that have no published slip (for mid-year / gap fill). */
export function countMissingPriorMonths(expectedPeriods: string[], ytdPeriods: string[]): number {
  const have = new Set(ytdPeriods);
  return expectedPeriods.filter((period) => !have.has(period)).length;
}

/** Use override when provided; otherwise computed TDS. */
export function resolvePlaygroundTds(
  computedTds: number,
  tdsOverride: number | null | undefined,
): { tds: number; source: 'computed' | 'override' } {
  if (tdsOverride != null && Number.isFinite(tdsOverride)) {
    return { tds: roundMoney(tdsOverride), source: 'override' };
  }
  return { tds: roundMoney(computedTds), source: 'computed' };
}
