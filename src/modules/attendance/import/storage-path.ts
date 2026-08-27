export const ATTENDANCE_IMPORT_BUCKET = 'attendance-imports';

export function originalExcelPath(importId: string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  return `${importId}/${safe || 'attendance.xlsx'}`;
}
