import * as XLSX from 'xlsx';
import { API_ERROR_CODES } from '../../../shared/constants/error-codes';
import { AppError } from '../../../shared/errors/app-error';
import { excelExtension } from './excel-file';

export function gridFromXlsx(buffer: Buffer): unknown[][] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'The workbook has no sheets.', 400);
  }
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' }) as unknown[][];
}

export function decodeBase64File(contentBase64: string): Buffer {
  const cleaned = contentBase64.includes(',') ? contentBase64.slice(contentBase64.indexOf(',') + 1) : contentBase64;
  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.length < 8) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Upload an Excel file (.xls or .xlsx).', 400);
  }
  return buffer;
}

/** Storage bucket only allows .xlsx MIME. Parse the original buffer; store Open XML. */
export function bufferForStorage(source: Buffer, fileName: string): { body: Buffer; storedName: string } {
  const ext = excelExtension(fileName) ?? '.xlsx';
  const storedName = fileName.replace(/\.(xls|xlsm|xlsb)$/i, '.xlsx');
  if (ext === '.xlsx') {
    return { body: source, storedName };
  }
  const workbook = XLSX.read(source, { type: 'buffer', cellDates: false });
  return {
    body: Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })),
    storedName,
  };
}
