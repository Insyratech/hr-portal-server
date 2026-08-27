/** Layout that matches the biometric monthly sheet: UserID/Name, 31 day headers, stacked times. */
export function biometricMonthGrid(opts?: { includeMissingUserId?: boolean }): unknown[][] {
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const times = days.map((day) => {
    if (day === 1) return '09:00\n18:05';
    if (day === 2) return '09:12';
    return '';
  });
  const grid: unknown[][] = [
    ['User ID : EMP01', 'Name : Ada Lovelace'],
    days,
    times,
  ];
  if (opts?.includeMissingUserId) {
    grid.push(['User ID :', 'Name : Unknown'], days, times);
  }
  return grid;
}
