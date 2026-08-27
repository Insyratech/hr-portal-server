const EXCEL_EXTENSIONS = ['.xlsx', '.xls', '.xlsm', '.xlsb'] as const;

const CONTENT_TYPE: Record<(typeof EXCEL_EXTENSIONS)[number], string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
};

export function excelExtension(fileName: string): (typeof EXCEL_EXTENSIONS)[number] | null {
  const lower = fileName.trim().toLowerCase();
  return EXCEL_EXTENSIONS.find((item) => lower.endsWith(item)) ?? null;
}

export function isExcelFileName(fileName: string): boolean {
  return excelExtension(fileName) !== null;
}

export function excelContentType(fileName: string): string {
  return CONTENT_TYPE[excelExtension(fileName) ?? '.xlsx'];
}
