import { ZstdInit, type ZstdCodec } from '@oneidentity/zstd-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';

let codecPromise: Promise<ZstdCodec> | null = null;

async function codec(): Promise<ZstdCodec> {
  if (!codecPromise) {
    codecPromise = ZstdInit();
  }
  return codecPromise;
}

export function decodeBase64Payload(contentBase64: string): Buffer {
  const cleaned = contentBase64.includes(',')
    ? contentBase64.slice(contentBase64.indexOf(',') + 1)
    : contentBase64;
  try {
    return Buffer.from(cleaned, 'base64');
  } catch {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invalid file payload.', 400);
  }
}

export function assertPdfBuffer(buffer: Buffer, fileName: string): void {
  const nameOk = /\.pdf$/i.test(fileName.trim());
  const magicOk = buffer.length >= 5 && buffer.subarray(0, 5).toString('utf8') === '%PDF-';
  if (!nameOk || !magicOk) {
    throw new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      'Upload a PDF only. Export Word/Docs to PDF before uploading.',
      400,
    );
  }
}

export async function compressPdfZstd(pdf: Buffer): Promise<Buffer> {
  const z = await codec();
  const compressed = z.ZstdSimple.compress(new Uint8Array(pdf));
  return Buffer.from(compressed);
}

export async function decompressPdfZstd(compressed: Buffer): Promise<Buffer> {
  const z = await codec();
  try {
    const pdf = z.ZstdSimple.decompress(new Uint8Array(compressed));
    return Buffer.from(pdf);
  } catch {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to decompress SOP PDF.', 500);
  }
}
