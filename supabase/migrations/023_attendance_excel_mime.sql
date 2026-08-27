-- Allow classic Excel MIME types on the attendance-imports bucket.

update storage.buckets
set allowed_mime_types = array[
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-excel.sheet.binary.macroEnabled.12'
]::text[]
where id = 'attendance-imports';
