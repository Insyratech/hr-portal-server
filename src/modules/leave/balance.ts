export function ledgerAvailable(rows: { quantity: number }[]): number {
  return rows.reduce((sum, row) => sum + Number(row.quantity), 0);
}

export function currentPeriod(now = new Date()): string {
  return String(now.getUTCFullYear());
}
