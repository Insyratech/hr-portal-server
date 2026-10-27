import {
  sanitizePersonNameForFile,
  WEEKLY_PPT_MAX_UPLOADS,
  WEEKLY_PPT_MIME,
  pptExtension,
} from './ppt-week';

export const JC_PPT_MAX_BYTES = 15 * 1024 * 1024;
export const JC_PPT_MAX_UPLOADS = WEEKLY_PPT_MAX_UPLOADS;
export const JC_PPT_BUCKET = 'jc-ppt-uploads';
export const JC_PPT_MIME = WEEKLY_PPT_MIME;

export { pptExtension };

export type JcPptStatus = 'uploaded' | 'with_gm' | 'downloaded' | 'emailed' | 'deleted';

/** File is still in the GM inbox (includes legacy `uploaded` rows before migration 090). */
export function jcStillWithGm(status: JcPptStatus | string): boolean {
  return status === 'with_gm' || status === 'uploaded';
}

export function buildJcPptSystemFileName(fullName: string, extension: '.ppt' | '.pptx'): string {
  const name = sanitizePersonNameForFile(fullName);
  const stamp = new Date().toISOString().slice(0, 10);
  return `${name}_JC_${stamp}${extension}`;
}

export function jcStatusLabel(status: JcPptStatus): string {
  if (status === 'uploaded' || status === 'with_gm') return 'With General Manager';
  if (status === 'downloaded') return 'Downloaded (file removed)';
  if (status === 'emailed') return 'Emailed (file removed)';
  return 'Deleted (file removed)';
}
