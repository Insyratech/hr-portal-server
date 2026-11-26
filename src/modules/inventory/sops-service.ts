import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canManageSops, type RequestMeta } from './access';
import {
  assertPdfBuffer,
  compressPdfZstd,
  decodeBase64Payload,
  decompressPdfZstd,
} from './sop-zstd';
import type {
  InventorySopFile,
  InventorySopFileContent,
  InventorySopFolder,
  InventoryStatus,
} from './types';

const SOP_BUCKET = 'inventory-sops';
const MAX_PDF_BYTES = 15 * 1024 * 1024;

type FolderRow = {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  status: InventoryStatus;
  created_at: string;
  updated_at: string;
};

type FileRow = {
  id: string;
  folder_id: string;
  title: string;
  original_file_name: string;
  storage_path: string;
  content_type: string;
  original_size_bytes: number;
  compressed_size_bytes: number;
  compression: string;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
};

function mapFolder(row: FolderRow, fileCount = 0, childCount = 0): InventorySopFolder {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    sortOrder: row.sort_order,
    status: row.status,
    fileCount,
    childCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFile(row: FileRow): InventorySopFile {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    originalFileName: row.original_file_name,
    contentType: row.content_type,
    originalSizeBytes: row.original_size_bytes,
    compressedSizeBytes: row.compressed_size_bytes,
    compression: 'zstd',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireSopManage(actor: RequestUser) {
  if (!canManageSops(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage SOPs.', 403);
  }
}

export function createInventorySopsService(supabase: SupabaseClient) {
  async function loadFolder(id: string): Promise<FolderRow> {
    const { data, error } = await supabase
      .from('inventory_sop_folders')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !data) {
      throw new AppError(API_ERROR_CODES.NOT_FOUND, 'SOP folder not found.', 404);
    }
    return data as FolderRow;
  }

  async function loadFile(id: string): Promise<FileRow> {
    const { data, error } = await supabase.from('inventory_sop_files').select('*').eq('id', id).single();
    if (error || !data) {
      throw new AppError(API_ERROR_CODES.NOT_FOUND, 'SOP file not found.', 404);
    }
    return data as FileRow;
  }

  async function readPdf(row: FileRow): Promise<InventorySopFileContent> {
    const { data, error } = await supabase.storage.from(SOP_BUCKET).download(row.storage_path);
    if (error || !data) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load SOP from storage.', 500);
    }
    const compressed = Buffer.from(await data.arrayBuffer());
    const pdf = await decompressPdfZstd(compressed);
    return {
      id: row.id,
      title: row.title,
      fileName: row.original_file_name.replace(/\.docx?$/i, '.pdf').replace(/\.pdf$/i, '') + '.pdf',
      contentType: 'application/pdf',
      contentBase64: pdf.toString('base64'),
      originalSizeBytes: row.original_size_bytes,
      compressedSizeBytes: row.compressed_size_bytes,
    };
  }

  return {
    async listFolders(actor: RequestUser, parentId?: string | null): Promise<InventorySopFolder[]> {
      requireSopManage(actor);
      let query = supabase
        .from('inventory_sop_folders')
        .select('*')
        .order('sort_order')
        .order('name');
      if (parentId === undefined || parentId === null || parentId === '') {
        query = query.is('parent_id', null);
      } else {
        query = query.eq('parent_id', parentId);
      }
      const { data, error } = await query;
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list SOP folders.', 500);
      }
      const folders = (data ?? []) as FolderRow[];
      if (!folders.length) return [];

      const ids = folders.map((row) => row.id);
      const [{ data: fileRows }, { data: childRows }] = await Promise.all([
        supabase.from('inventory_sop_files').select('folder_id').in('folder_id', ids),
        supabase.from('inventory_sop_folders').select('parent_id').in('parent_id', ids),
      ]);
      const fileCounts = new Map<string, number>();
      for (const row of (fileRows ?? []) as Array<{ folder_id: string }>) {
        fileCounts.set(row.folder_id, (fileCounts.get(row.folder_id) ?? 0) + 1);
      }
      const childCounts = new Map<string, number>();
      for (const row of (childRows ?? []) as Array<{ parent_id: string }>) {
        childCounts.set(row.parent_id, (childCounts.get(row.parent_id) ?? 0) + 1);
      }
      return folders.map((row) =>
        mapFolder(row, fileCounts.get(row.id) ?? 0, childCounts.get(row.id) ?? 0),
      );
    },

    async createFolder(
      actor: RequestUser,
      input: { name: string; parentId?: string | null; sortOrder?: number },
      meta: RequestMeta = {},
    ): Promise<InventorySopFolder> {
      requireSopManage(actor);
      const name = input.name.trim();
      if (!name) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Folder name is required.', 400);
      }
      const parentId = input.parentId?.trim() || null;
      if (parentId) {
        await loadFolder(parentId);
      }
      const { data, error } = await supabase
        .from('inventory_sop_folders')
        .insert({
          name,
          parent_id: parentId,
          sort_order: Number.isFinite(input.sortOrder) ? Math.trunc(input.sortOrder!) : 100,
          status: 'active',
          created_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'A folder with that name already exists here.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create folder.', 500);
      }
      const folder = mapFolder(data as FolderRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_sop_folder.create',
        entityType: 'inventory_sop_folder',
        entityId: folder.id,
        newValues: { name: folder.name, parentId: folder.parentId },
        ...meta,
      });
      return folder;
    },

    async updateFolder(
      actor: RequestUser,
      id: string,
      input: { name?: string; sortOrder?: number; status?: InventoryStatus; parentId?: string | null },
      meta: RequestMeta = {},
    ): Promise<InventorySopFolder> {
      requireSopManage(actor);
      await loadFolder(id);
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Folder name is required.', 400);
        }
        patch.name = name;
      }
      if (input.sortOrder !== undefined) {
        patch.sort_order = Math.trunc(input.sortOrder);
      }
      if (input.status !== undefined) {
        patch.status = input.status;
      }
      if (input.parentId !== undefined) {
        const parentId = input.parentId?.trim() || null;
        if (parentId === id) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Folder cannot be its own parent.', 400);
        }
        if (parentId) {
          await loadFolder(parentId);
        }
        patch.parent_id = parentId;
      }
      if (!Object.keys(patch).length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'No folder changes provided.', 400);
      }
      const { data, error } = await supabase
        .from('inventory_sop_folders')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'A folder with that name already exists here.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to update folder.', 500);
      }
      const folder = mapFolder(data as FolderRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_sop_folder.update',
        entityType: 'inventory_sop_folder',
        entityId: id,
        newValues: patch,
        ...meta,
      });
      return folder;
    },

    async deleteFolder(actor: RequestUser, id: string, meta: RequestMeta = {}): Promise<{ id: string }> {
      requireSopManage(actor);
      const folder = await loadFolder(id);
      const [{ count: fileCount }, { count: childCount }] = await Promise.all([
        supabase
          .from('inventory_sop_files')
          .select('id', { count: 'exact', head: true })
          .eq('folder_id', id),
        supabase
          .from('inventory_sop_folders')
          .select('id', { count: 'exact', head: true })
          .eq('parent_id', id),
      ]);
      if ((fileCount ?? 0) > 0 || (childCount ?? 0) > 0) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Empty the folder (remove files and subfolders) before deleting it.',
          400,
        );
      }
      const { error } = await supabase.from('inventory_sop_folders').delete().eq('id', id);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message ?? 'Failed to delete folder.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_sop_folder.delete',
        entityType: 'inventory_sop_folder',
        entityId: id,
        oldValues: { name: folder.name },
        ...meta,
      });
      return { id };
    },

    async listFiles(actor: RequestUser, folderId: string): Promise<InventorySopFile[]> {
      requireSopManage(actor);
      await loadFolder(folderId);
      const { data, error } = await supabase
        .from('inventory_sop_files')
        .select('*')
        .eq('folder_id', folderId)
        .order('title');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list SOP files.', 500);
      }
      return ((data ?? []) as FileRow[]).map(mapFile);
    },

    async listAllFiles(actor: RequestUser): Promise<InventorySopFile[]> {
      requireSopManage(actor);
      const { data, error } = await supabase
        .from('inventory_sop_files')
        .select('*')
        .order('title');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list SOP files.', 500);
      }
      return ((data ?? []) as FileRow[]).map(mapFile);
    },

    async uploadFile(
      actor: RequestUser,
      folderId: string,
      input: { title?: string; fileName: string; contentBase64: string },
      meta: RequestMeta = {},
    ): Promise<InventorySopFile> {
      requireSopManage(actor);
      await loadFolder(folderId);
      const fileName = input.fileName.trim();
      if (!fileName) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'File name is required.', 400);
      }
      const pdf = decodeBase64Payload(input.contentBase64);
      if (pdf.length <= 0 || pdf.length > MAX_PDF_BYTES) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `PDF must be between 1 byte and ${Math.floor(MAX_PDF_BYTES / (1024 * 1024))} MB.`,
          400,
        );
      }
      assertPdfBuffer(pdf, fileName);
      const title =
        (input.title ?? '').trim() ||
        fileName.replace(/\.pdf$/i, '').trim() ||
        'Untitled SOP';
      const compressed = await compressPdfZstd(pdf);
      const storagePath = `${folderId}/${randomUUID()}.pdf.zst`;
      const { error: storageError } = await supabase.storage.from(SOP_BUCKET).upload(storagePath, compressed, {
        contentType: 'application/zstd',
        upsert: false,
      });
      if (storageError) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          storageError.message || 'Failed to store SOP. Ensure the inventory-sops bucket exists.',
          500,
        );
      }

      const { data, error } = await supabase
        .from('inventory_sop_files')
        .insert({
          folder_id: folderId,
          title,
          original_file_name: fileName.replace(/\.docx?$/i, '.pdf'),
          storage_path: storagePath,
          content_type: 'application/pdf',
          original_size_bytes: pdf.length,
          compressed_size_bytes: compressed.length,
          compression: 'zstd',
          uploaded_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        await supabase.storage.from(SOP_BUCKET).remove([storagePath]);
        if (error?.code === '23505') {
          throw new AppError(
            API_ERROR_CODES.CONFLICT,
            'An SOP with that title already exists in this folder.',
            409,
          );
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to save SOP metadata.', 500);
      }

      const file = mapFile(data as FileRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_sop_file.upload',
        entityType: 'inventory_sop_file',
        entityId: file.id,
        newValues: {
          title: file.title,
          folderId,
          originalSizeBytes: file.originalSizeBytes,
          compressedSizeBytes: file.compressedSizeBytes,
        },
        ...meta,
      });
      return file;
    },

    async updateFile(
      actor: RequestUser,
      id: string,
      input: { title?: string; folderId?: string },
      meta: RequestMeta = {},
    ): Promise<InventorySopFile> {
      requireSopManage(actor);
      await loadFile(id);
      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) {
        const title = input.title.trim();
        if (!title) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Title is required.', 400);
        }
        patch.title = title;
      }
      if (input.folderId !== undefined) {
        const folderId = input.folderId.trim();
        await loadFolder(folderId);
        patch.folder_id = folderId;
      }
      if (!Object.keys(patch).length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'No file changes provided.', 400);
      }
      const { data, error } = await supabase
        .from('inventory_sop_files')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(
            API_ERROR_CODES.CONFLICT,
            'An SOP with that title already exists in this folder.',
            409,
          );
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to update SOP.', 500);
      }
      const file = mapFile(data as FileRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_sop_file.update',
        entityType: 'inventory_sop_file',
        entityId: id,
        newValues: patch,
        ...meta,
      });
      return file;
    },

    async deleteFile(actor: RequestUser, id: string, meta: RequestMeta = {}): Promise<{ id: string }> {
      requireSopManage(actor);
      const row = await loadFile(id);
      const { error } = await supabase.from('inventory_sop_files').delete().eq('id', id);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message ?? 'Failed to delete SOP.', 500);
      }
      await supabase.storage.from(SOP_BUCKET).remove([row.storage_path]);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_sop_file.delete',
        entityType: 'inventory_sop_file',
        entityId: id,
        oldValues: { title: row.title, folderId: row.folder_id },
        ...meta,
      });
      return { id };
    },

    async getFilePdf(actor: RequestUser, id: string): Promise<InventorySopFileContent> {
      requireSopManage(actor);
      const row = await loadFile(id);
      return readPdf(row);
    },

    /** Public Inside lab preview — gated by active inside_lab QR token + linked recipe. */
    async getPublicRecipeSop(token: string, recipeId: string): Promise<InventorySopFileContent> {
      const qrToken = token.trim();
      const { data: central, error: centralError } = await supabase
        .from('inventory_central_qrs')
        .select('id, kind, status')
        .eq('qr_token', qrToken)
        .maybeSingle();
      if (centralError || !central || central.status !== 'active' || central.kind !== 'inside_lab') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Scan the Inside lab usage area QR.', 400);
      }

      const { data: recipe, error: recipeError } = await supabase
        .from('inventory_lab_recipes')
        .select('id, status, sop_file_id')
        .eq('id', recipeId)
        .maybeSingle();
      if (recipeError || !recipe || recipe.status !== 'active') {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Recipe not found.', 404);
      }
      const sopFileId = (recipe.sop_file_id as string | null) ?? null;
      if (!sopFileId) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'No SOP is linked to this recipe.', 404);
      }
      const row = await loadFile(sopFileId);
      return readPdf(row);
    },
  };
}
