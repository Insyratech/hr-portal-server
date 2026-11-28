import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canManageLab, type RequestMeta } from './access';
import { buildGelLines, formatGelRunLabel, type GelComponentKey } from './gel-chart';
import { findPcrTestingType, PCR_TESTING_TYPES } from './pcr-testing-templates';
import type {
  InventoryLabActivity,
  InventoryLabGelChart,
  InventoryLabGelComponentKey,
  InventoryLabGelComponentLink,
  InventoryLabManualUsageResult,
  InventoryLabRecipe,
  InventoryLabRecipeComponent,
  InventoryLabUsageComponentLine,
  InventoryLabUsageMode,
  InventoryLabUsageResult,
  InventoryPcrTestingType,
  InventoryPublicLabCatalogItem,
  InventoryStatus,
} from './types';

const MANUAL_PROTOCOL_UNITS = new Set(['mg', 'g', 'ul', 'ml', 'l']);

function newQrToken(): string {
  return randomBytes(24).toString('base64url');
}

function newLotCode(now = new Date()): string {
  const y = now.getUTCFullYear().toString().slice(-2);
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const rand = randomBytes(3).toString('hex').toUpperCase();
  return `LOT-${y}${m}${d}-${rand}`;
}

type ActivityRow = {
  id: string;
  name: string;
  description: string;
  sort_order: number;
  status: InventoryStatus;
  usage_mode?: InventoryLabUsageMode | null;
  created_at: string;
  updated_at: string;
};

function mapUsageMode(value: string | null | undefined): InventoryLabUsageMode {
  if (value === 'recipe') return 'recipe';
  if (value === 'gel') return 'gel';
  if (value === 'pcr') return 'pcr';
  return 'method';
}

function normalizeUsageMode(value: InventoryLabUsageMode | undefined): InventoryLabUsageMode {
  if (value === 'recipe') return 'recipe';
  if (value === 'gel') return 'gel';
  if (value === 'pcr') return 'pcr';
  return 'method';
}

/** DNA/Loading methods and PCR runs both record an Nx multiplier. */
function scalesWithNx(mode: InventoryLabUsageMode): boolean {
  return mode === 'method' || mode === 'pcr';
}

function normalizeManualUnit(value: string): string {
  return value.trim().toLowerCase();
}

function nxItemLabel(mode: InventoryLabUsageMode): string {
  if (mode === 'pcr') return 'master mix';
  if (mode === 'gel') return 'gel run';
  if (mode === 'method') return 'method';
  return 'recipe';
}

function asFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

type GelComponentRow = {
  id: string;
  activity_id: string;
  component_key: string;
  name: string;
  catalog_item_id: string | null;
  sort_order: number;
  inventory_catalog_items?: { name: string } | { name: string }[] | null;
};

function mapGelComponent(row: GelComponentRow): InventoryLabGelComponentLink {
  const catalog = Array.isArray(row.inventory_catalog_items)
    ? row.inventory_catalog_items[0]
    : row.inventory_catalog_items;
  const key = row.component_key as InventoryLabGelComponentKey;
  return {
    id: row.id,
    activityId: row.activity_id,
    componentKey: key === 'agarose' || key === 'buffer' || key === 'stain' ? key : 'stain',
    name: row.name,
    catalogItemId: row.catalog_item_id,
    catalogItemName: catalog?.name ?? '',
    sortOrder: row.sort_order,
  };
}

function mapActivity(row: ActivityRow, recipeCount = 0): InventoryLabActivity {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sortOrder: row.sort_order,
    status: row.status,
    usageMode: mapUsageMode(row.usage_mode),
    recipeCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type RecipeRow = {
  id: string;
  activity_id: string;
  name: string;
  final_volume_value: number | string | null;
  final_volume_unit: string;
  notes: string;
  sort_order: number;
  status: InventoryStatus;
  creates_output_lot?: boolean | null;
  output_catalog_item_id?: string | null;
  sop_file_id?: string | null;
  created_at: string;
  updated_at: string;
  inventory_lab_activities?: { name: string } | { name: string }[] | null;
  inventory_catalog_items?: { name: string } | { name: string }[] | null;
  inventory_sop_files?: { title: string } | { title: string }[] | null;
};

type ComponentRow = {
  id: string;
  recipe_id: string;
  name: string;
  quantity_value: number | string | null;
  quantity_unit: string;
  notes: string;
  sort_order: number;
  catalog_item_id: string | null;
  created_at: string;
  updated_at: string;
  inventory_catalog_items?: { name: string } | { name: string }[] | null;
};

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function asNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function mapComponent(row: ComponentRow): InventoryLabRecipeComponent {
  const catalog = one(row.inventory_catalog_items ?? null);
  return {
    id: row.id,
    recipeId: row.recipe_id,
    name: row.name,
    quantityValue: asNumberOrNull(row.quantity_value),
    quantityUnit: row.quantity_unit,
    notes: row.notes,
    sortOrder: row.sort_order,
    catalogItemId: row.catalog_item_id,
    catalogItemName: catalog?.name ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRecipe(
  row: RecipeRow,
  components: InventoryLabRecipeComponent[] = [],
  outputCatalogItemName = '',
): InventoryLabRecipe {
  const activity = one(row.inventory_lab_activities ?? null);
  const sop = one(row.inventory_sop_files ?? null);
  return {
    id: row.id,
    activityId: row.activity_id,
    activityName: activity?.name ?? '',
    name: row.name,
    finalVolumeValue: asNumberOrNull(row.final_volume_value),
    finalVolumeUnit: row.final_volume_unit,
    notes: row.notes,
    sortOrder: row.sort_order,
    status: row.status,
    createsOutputLot: Boolean(row.creates_output_lot),
    outputCatalogItemId: row.output_catalog_item_id ?? null,
    outputCatalogItemName,
    sopFileId: row.sop_file_id ?? null,
    sopTitle: sop?.title ?? '',
    components,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const RECIPE_SELECT = '*, inventory_lab_activities(name), inventory_sop_files(title)';
const COMPONENT_SELECT = '*, inventory_catalog_items(name)';

export function createInventoryLabRecipesService(supabase: SupabaseClient) {
  async function loadComponents(recipeId: string): Promise<InventoryLabRecipeComponent[]> {
    const { data, error } = await supabase
      .from('inventory_lab_recipe_components')
      .select(COMPONENT_SELECT)
      .eq('recipe_id', recipeId)
      .order('sort_order')
      .order('name');
    if (error) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load recipe components.', 500);
    }
    return ((data ?? []) as ComponentRow[]).map(mapComponent);
  }

  async function resolveOutputCatalogName(catalogItemId: string | null | undefined): Promise<string> {
    if (!catalogItemId) return '';
    const { data } = await supabase
      .from('inventory_catalog_items')
      .select('name')
      .eq('id', catalogItemId)
      .maybeSingle();
    return (data?.name as string | undefined) ?? '';
  }

  async function loadRecipe(id: string): Promise<InventoryLabRecipe> {
    const { data, error } = await supabase
      .from('inventory_lab_recipes')
      .select(RECIPE_SELECT)
      .eq('id', id)
      .single();
    if (error || !data) {
      throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Recipe not found.', 404);
    }
    const row = data as RecipeRow;
    const components = await loadComponents(id);
    const outputName = await resolveOutputCatalogName(row.output_catalog_item_id);
    return mapRecipe(row, components, outputName);
  }

  return {
    async listActivities(actor: RequestUser): Promise<InventoryLabActivity[]> {
      if (!canManageLab(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage lab recipes.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_lab_activities')
        .select('*')
        .order('sort_order')
        .order('name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list lab activities.', 500);
      }
      const activities = (data ?? []) as ActivityRow[];
      const counts = new Map<string, number>();
      if (activities.length) {
        const { data: recipeRows } = await supabase
          .from('inventory_lab_recipes')
          .select('activity_id')
          .in(
            'activity_id',
            activities.map((row) => row.id),
          );
        for (const row of (recipeRows ?? []) as Array<{ activity_id: string }>) {
          counts.set(row.activity_id, (counts.get(row.activity_id) ?? 0) + 1);
        }
      }
      return activities.map((row) => mapActivity(row, counts.get(row.id) ?? 0));
    },

    async createActivity(
      actor: RequestUser,
      input: {
        name: string;
        description?: string;
        sortOrder?: number;
        usageMode?: InventoryLabUsageMode;
      },
      meta: RequestMeta,
    ): Promise<InventoryLabActivity> {
      if (!canManageLab(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage lab recipes.', 403);
      }
      const name = input.name.trim();
      if (!name) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Activity name is required.', 400);
      }
      const usageMode = normalizeUsageMode(input.usageMode);
      const { data, error } = await supabase
        .from('inventory_lab_activities')
        .insert({
          name,
          description: (input.description ?? '').trim(),
          sort_order: Number.isFinite(input.sortOrder) ? Math.trunc(input.sortOrder!) : 100,
          status: 'active',
          usage_mode: usageMode,
        })
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'An activity with that name already exists.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create activity.', 500);
      }
      const row = data as ActivityRow;
      if (usageMode === 'gel') {
        const { error: gelSeedError } = await supabase.from('inventory_lab_gel_components').insert([
          { activity_id: row.id, component_key: 'agarose', name: 'Agarose', sort_order: 10 },
          { activity_id: row.id, component_key: 'buffer', name: '1X TAE Buffer', sort_order: 20 },
          { activity_id: row.id, component_key: 'stain', name: 'EtBr', sort_order: 30 },
        ]);
        if (gelSeedError) {
          throw new AppError(
            API_ERROR_CODES.INTERNAL_ERROR,
            gelSeedError.message ?? 'Work type created but gel component rows failed.',
            500,
          );
        }
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_lab_activity.create',
        entityType: 'inventory_lab_activity',
        entityId: row.id,
        newValues: { name: row.name, usageMode },
        ...meta,
      });
      return mapActivity(row, 0);
    },

    async updateActivity(
      actor: RequestUser,
      id: string,
      input: {
        name?: string;
        description?: string;
        sortOrder?: number;
        status?: InventoryStatus;
        usageMode?: InventoryLabUsageMode;
      },
      meta: RequestMeta,
    ): Promise<InventoryLabActivity> {
      if (!canManageLab(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage lab recipes.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Activity name is required.', 400);
        }
        patch.name = name;
      }
      if (input.description !== undefined) patch.description = input.description.trim();
      if (input.sortOrder !== undefined) patch.sort_order = Math.trunc(input.sortOrder);
      if (input.status !== undefined) patch.status = input.status;
      if (input.usageMode !== undefined) {
        patch.usage_mode = normalizeUsageMode(input.usageMode);
      }
      if (!Object.keys(patch).length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Nothing to update.', 400);
      }
      const { data, error } = await supabase
        .from('inventory_lab_activities')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'An activity with that name already exists.', 409);
        }
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Activity not found.', 404);
      }
      const list = await this.listActivities(actor);
      const updated = list.find((row) => row.id === id);
      if (!updated) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Activity not found.', 404);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_lab_activity.update',
        entityType: 'inventory_lab_activity',
        entityId: id,
        newValues: patch,
        ...meta,
      });
      return updated;
    },

    async listRecipes(actor: RequestUser, activityId?: string): Promise<InventoryLabRecipe[]> {
      if (!canManageLab(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage lab recipes.', 403);
      }
      let query = supabase.from('inventory_lab_recipes').select(RECIPE_SELECT).order('sort_order').order('name');
      if (activityId) query = query.eq('activity_id', activityId);
      const { data, error } = await query;
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list recipes.', 500);
      }
      const recipes = (data ?? []) as RecipeRow[];
      const result: InventoryLabRecipe[] = [];
      for (const row of recipes) {
        result.push(
          mapRecipe(
            row,
            await loadComponents(row.id),
            await resolveOutputCatalogName(row.output_catalog_item_id),
          ),
        );
      }
      return result;
    },

    async getRecipe(actor: RequestUser, id: string): Promise<InventoryLabRecipe> {
      if (!canManageLab(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage lab recipes.', 403);
      }
      return loadRecipe(id);
    },

    /** Public read for Inside lab scan (Phase C). Active only. */
    async listPublicActivities(): Promise<InventoryLabActivity[]> {
      const { data, error } = await supabase
        .from('inventory_lab_activities')
        .select('*')
        .eq('status', 'active')
        .order('sort_order')
        .order('name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list lab activities.', 500);
      }
      return ((data ?? []) as ActivityRow[]).map((row) => mapActivity(row, 0));
    },

    async listPublicRecipes(activityId: string): Promise<InventoryLabRecipe[]> {
      const { data, error } = await supabase
        .from('inventory_lab_recipes')
        .select(RECIPE_SELECT)
        .eq('activity_id', activityId)
        .eq('status', 'active')
        .order('sort_order')
        .order('name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list recipes.', 500);
      }
      const recipes = (data ?? []) as RecipeRow[];
      const result: InventoryLabRecipe[] = [];
      for (const row of recipes) {
        result.push(
          mapRecipe(
            row,
            await loadComponents(row.id),
            await resolveOutputCatalogName(row.output_catalog_item_id),
          ),
        );
      }
      return result;
    },

    async getPublicRecipe(id: string): Promise<InventoryLabRecipe> {
      const recipe = await loadRecipe(id);
      if (recipe.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This recipe is inactive.', 400);
      }
      return recipe;
    },

    async createRecipe(
      actor: RequestUser,
      input: {
        activityId: string;
        name: string;
        finalVolumeValue?: number | null;
        finalVolumeUnit?: string;
        notes?: string;
        sortOrder?: number;
        createsOutputLot?: boolean;
        outputCatalogItemId?: string | null;
        sopFileId?: string | null;
        components?: Array<{
          name: string;
          quantityValue?: number | null;
          quantityUnit?: string;
          notes?: string;
          sortOrder?: number;
          catalogItemId?: string | null;
        }>;
      },
      meta: RequestMeta,
    ): Promise<InventoryLabRecipe> {
      if (!canManageLab(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage lab recipes.', 403);
      }
      const name = input.name.trim();
      if (!name) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Recipe name is required.', 400);
      }
      const { data: activity, error: activityError } = await supabase
        .from('inventory_lab_activities')
        .select('id')
        .eq('id', input.activityId)
        .single();
      if (activityError || !activity) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unknown lab activity.', 400);
      }
      if (input.sopFileId) {
        const { data: sop, error: sopError } = await supabase
          .from('inventory_sop_files')
          .select('id')
          .eq('id', input.sopFileId)
          .maybeSingle();
        if (sopError || !sop) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unknown SOP file.', 400);
        }
      }

      const { data: inserted, error } = await supabase
        .from('inventory_lab_recipes')
        .insert({
          activity_id: input.activityId,
          name,
          final_volume_value:
            input.finalVolumeValue === undefined || input.finalVolumeValue === null
              ? null
              : Number(input.finalVolumeValue),
          final_volume_unit: (input.finalVolumeUnit ?? '').trim(),
          notes: (input.notes ?? '').trim(),
          sort_order: Number.isFinite(input.sortOrder) ? Math.trunc(input.sortOrder!) : 100,
          status: 'active',
          creates_output_lot: Boolean(input.createsOutputLot),
          output_catalog_item_id: input.outputCatalogItemId || null,
          sop_file_id: input.sopFileId || null,
        })
        .select(RECIPE_SELECT)
        .single();
      if (error || !inserted) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'A recipe with that name already exists under this activity.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create recipe.', 500);
      }

      const recipeId = (inserted as RecipeRow).id;
      const components = input.components ?? [];
      if (components.length) {
        const rows = components.map((component, index) => {
          const componentName = component.name.trim();
          if (!componentName) {
            throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Each component needs a name.', 400);
          }
          return {
            recipe_id: recipeId,
            name: componentName,
            quantity_value:
              component.quantityValue === undefined || component.quantityValue === null
                ? null
                : Number(component.quantityValue),
            quantity_unit: (component.quantityUnit ?? '').trim(),
            notes: (component.notes ?? '').trim(),
            sort_order:
              Number.isFinite(component.sortOrder) ? Math.trunc(component.sortOrder!) : (index + 1) * 10,
            catalog_item_id: component.catalogItemId || null,
          };
        });
        const { error: componentError } = await supabase
          .from('inventory_lab_recipe_components')
          .insert(rows);
        if (componentError) {
          throw new AppError(
            API_ERROR_CODES.INTERNAL_ERROR,
            componentError.message ?? 'Recipe created but components failed.',
            500,
          );
        }
      }

      const recipe = await loadRecipe(recipeId);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_lab_recipe.create',
        entityType: 'inventory_lab_recipe',
        entityId: recipe.id,
        newValues: { name: recipe.name, activityId: recipe.activityId },
        ...meta,
      });
      return recipe;
    },

    async updateRecipe(
      actor: RequestUser,
      id: string,
      input: {
        name?: string;
        finalVolumeValue?: number | null;
        finalVolumeUnit?: string;
        notes?: string;
        sortOrder?: number;
        status?: InventoryStatus;
        createsOutputLot?: boolean;
        outputCatalogItemId?: string | null;
        sopFileId?: string | null;
        components?: Array<{
          id?: string;
          name: string;
          quantityValue?: number | null;
          quantityUnit?: string;
          notes?: string;
          sortOrder?: number;
          catalogItemId?: string | null;
        }>;
      },
      meta: RequestMeta,
    ): Promise<InventoryLabRecipe> {
      if (!canManageLab(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage lab recipes.', 403);
      }
      await loadRecipe(id);

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Recipe name is required.', 400);
        }
        patch.name = name;
      }
      if (input.finalVolumeValue !== undefined) {
        patch.final_volume_value =
          input.finalVolumeValue === null ? null : Number(input.finalVolumeValue);
      }
      if (input.finalVolumeUnit !== undefined) patch.final_volume_unit = input.finalVolumeUnit.trim();
      if (input.notes !== undefined) patch.notes = input.notes.trim();
      if (input.sortOrder !== undefined) patch.sort_order = Math.trunc(input.sortOrder);
      if (input.status !== undefined) patch.status = input.status;
      if (input.createsOutputLot !== undefined) patch.creates_output_lot = Boolean(input.createsOutputLot);
      if (input.outputCatalogItemId !== undefined) {
        patch.output_catalog_item_id = input.outputCatalogItemId || null;
      }
      if (input.sopFileId !== undefined) {
        const sopFileId = input.sopFileId?.trim() || null;
        if (sopFileId) {
          const { data: sop, error: sopError } = await supabase
            .from('inventory_sop_files')
            .select('id')
            .eq('id', sopFileId)
            .maybeSingle();
          if (sopError || !sop) {
            throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unknown SOP file.', 400);
          }
        }
        patch.sop_file_id = sopFileId;
      }

      if (Object.keys(patch).length) {
        const { error } = await supabase.from('inventory_lab_recipes').update(patch).eq('id', id);
        if (error) {
          if (error.code === '23505') {
            throw new AppError(
              API_ERROR_CODES.CONFLICT,
              'A recipe with that name already exists under this activity.',
              409,
            );
          }
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message ?? 'Failed to update recipe.', 500);
        }
      }

      if (input.components) {
        const { error: deleteError } = await supabase
          .from('inventory_lab_recipe_components')
          .delete()
          .eq('recipe_id', id);
        if (deleteError) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to replace recipe components.', 500);
        }
        if (input.components.length) {
          const rows = input.components.map((component, index) => {
            const componentName = component.name.trim();
            if (!componentName) {
              throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Each component needs a name.', 400);
            }
            return {
              recipe_id: id,
              name: componentName,
              quantity_value:
                component.quantityValue === undefined || component.quantityValue === null
                  ? null
                  : Number(component.quantityValue),
              quantity_unit: (component.quantityUnit ?? '').trim(),
              notes: (component.notes ?? '').trim(),
              sort_order:
                Number.isFinite(component.sortOrder) ? Math.trunc(component.sortOrder!) : (index + 1) * 10,
              catalog_item_id: component.catalogItemId || null,
            };
          });
          const { error: insertError } = await supabase
            .from('inventory_lab_recipe_components')
            .insert(rows);
          if (insertError) {
            throw new AppError(
              API_ERROR_CODES.INTERNAL_ERROR,
              insertError.message ?? 'Failed to save recipe components.',
              500,
            );
          }
        }
      }

      const recipe = await loadRecipe(id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_lab_recipe.update',
        entityType: 'inventory_lab_recipe',
        entityId: id,
        newValues: { name: recipe.name, componentCount: recipe.components.length },
        ...meta,
      });
      return recipe;
    },

    async deleteRecipe(actor: RequestUser, id: string, meta: RequestMeta): Promise<{ id: string }> {
      if (!canManageLab(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage lab recipes.', 403);
      }
      const existing = await loadRecipe(id);
      const { error } = await supabase.from('inventory_lab_recipes').delete().eq('id', id);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message ?? 'Failed to delete recipe.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_lab_recipe.delete',
        entityType: 'inventory_lab_recipe',
        entityId: id,
        oldValues: { name: existing.name, activityId: existing.activityId },
        ...meta,
      });
      return { id };
    },

    async getGelChart(activityId: string): Promise<InventoryLabGelChart> {
      const { data: activity, error: activityError } = await supabase
        .from('inventory_lab_activities')
        .select('id, usage_mode, status')
        .eq('id', activityId)
        .single();
      if (activityError || !activity) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Work type not found.', 404);
      }
      if (mapUsageMode((activity as { usage_mode?: string }).usage_mode) !== 'gel') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This work type is not gel chart mode.', 400);
      }

      const [{ data: percentRows }, { data: volumeRows }, { data: etbrRows }, { data: componentRows, error: componentError }] =
        await Promise.all([
          supabase.from('inventory_lab_gel_percentages').select('percent').order('percent'),
          supabase.from('inventory_lab_gel_volumes').select('volume_ml').order('volume_ml'),
          supabase.from('inventory_lab_gel_etbr_by_volume').select('volume_ml, etbr_ul'),
          supabase
            .from('inventory_lab_gel_components')
            .select('*, inventory_catalog_items(name)')
            .eq('activity_id', activityId)
            .order('sort_order'),
        ]);
      if (componentError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load gel components.', 500);
      }

      const etbrUlByVolumeMl: Record<string, number> = {};
      for (const row of (etbrRows ?? []) as Array<{ volume_ml: number | string; etbr_ul: number | string }>) {
        const volume = asFiniteNumber(row.volume_ml);
        const etbr = asFiniteNumber(row.etbr_ul);
        if (volume !== null && etbr !== null) etbrUlByVolumeMl[String(volume)] = etbr;
      }

      return {
        activityId,
        percentages: ((percentRows ?? []) as Array<{ percent: number | string }>)
          .map((row) => asFiniteNumber(row.percent))
          .filter((value): value is number => value !== null),
        volumesMl: ((volumeRows ?? []) as Array<{ volume_ml: number | string }>)
          .map((row) => asFiniteNumber(row.volume_ml))
          .filter((value): value is number => value !== null),
        etbrUlByVolumeMl,
        components: ((componentRows ?? []) as GelComponentRow[]).map(mapGelComponent),
      };
    },

    async getManagedGelChart(actor: RequestUser, activityId: string): Promise<InventoryLabGelChart> {
      if (!canManageLab(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage lab recipes.', 403);
      }
      return this.getGelChart(activityId);
    },

    /** Public SOP testing-type templates for PCR reaction only. */
    async listPublicPcrTestingTypes(activityId: string): Promise<InventoryPcrTestingType[]> {
      const { data, error } = await supabase
        .from('inventory_lab_activities')
        .select('id, usage_mode, status')
        .eq('id', activityId)
        .single();
      if (error || !data || data.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unknown or inactive work type.', 400);
      }
      if (mapUsageMode(data.usage_mode) !== 'pcr') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Testing types are only available for PCR reaction.',
          400,
        );
      }
      return PCR_TESTING_TYPES.map((row) => ({
        id: row.id,
        name: row.name,
        totalVolumeValue: row.totalVolumeValue,
        totalVolumeUnit: row.totalVolumeUnit,
        components: row.components.map((component) => ({ ...component })),
      }));
    },

    async updateGelComponentLinks(
      actor: RequestUser,
      activityId: string,
      input: {
        components: Array<{
          componentKey: InventoryLabGelComponentKey;
          name?: string;
          catalogItemId?: string | null;
        }>;
      },
      meta: RequestMeta,
    ): Promise<InventoryLabGelChart> {
      if (!canManageLab(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage lab recipes.', 403);
      }
      const chart = await this.getGelChart(activityId);
      for (const patch of input.components ?? []) {
        const key = patch.componentKey;
        if (key !== 'agarose' && key !== 'buffer' && key !== 'stain') {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unknown gel component key.', 400);
        }
        const existing = chart.components.find((row) => row.componentKey === key);
        if (!existing) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, `Missing gel component row for ${key}.`, 400);
        }
        const update: Record<string, unknown> = {};
        if (patch.name !== undefined) {
          const name = patch.name.trim();
          if (!name) throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Component name is required.', 400);
          update.name = name;
        }
        if (patch.catalogItemId !== undefined) {
          update.catalog_item_id = patch.catalogItemId || null;
        }
        if (!Object.keys(update).length) continue;
        const { error } = await supabase
          .from('inventory_lab_gel_components')
          .update(update)
          .eq('id', existing.id);
        if (error) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message ?? 'Failed to update gel link.', 500);
        }
      }
      const next = await this.getGelChart(activityId);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_lab_gel_links.update',
        entityType: 'inventory_lab_activity',
        entityId: activityId,
        newValues: {
          components: next.components.map((row) => ({
            key: row.componentKey,
            catalogItemId: row.catalogItemId,
          })),
        },
        ...meta,
      });
      return next;
    },

    async submitPublicUsage(
      centralQrToken: string,
      input: {
        employeeId: string;
        activityId: string;
        recipeId?: string | null;
        notes?: string;
        components?: Array<{
          name: string;
          quantityValue?: number | null;
          quantityUnit?: string;
          notes?: string;
          catalogItemId?: string | null;
        }>;
        outputQty?: number | null;
        /** How many reactions/extractions (Nx). Applies to method and pcr work types. */
        quantityMultiplier?: number | null;
        /** Agarose % w/v for gel chart runs. */
        gelPercent?: number | null;
        /** Target gel volume (mL) for gel chart runs. */
        gelVolumeMl?: number | null;
        /** PCR: master mix volume per 1X reaction (defaults to recipe/10). */
        masterMixVolumePerReaction?: number | null;
        /** PCR: unit for master mix volume (mg|g|ul|ml|l). */
        masterMixUnit?: string | null;
        /** PCR: free-text mixture rows (primer/NFW/template…). Logged only — no lot deduct. */
        mixtureComponents?: Array<{
          name: string;
          quantityValue?: number | null;
          quantityUnit?: string;
        }>;
        /** PCR Testing checkbox: SOP testing-type id (optional). */
        pcrTestingTypeId?: string | null;
      },
      meta: RequestMeta = {},
    ): Promise<InventoryLabUsageResult> {
      const token = centralQrToken.trim();
      if (!token) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Unknown usage area.', 404);
      }
      const { data: centralRow, error: centralError } = await supabase
        .from('inventory_central_qrs')
        .select('id, kind, name, status, qr_token')
        .eq('qr_token', token)
        .single();
      if (centralError || !centralRow) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Unknown usage area.', 404);
      }
      if (centralRow.status !== 'active' || centralRow.kind !== 'inside_lab') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Lab work logging is only available on the Inside lab QR.',
          400,
        );
      }

      if (!input.employeeId || !input.activityId) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Employee and work type are required.',
          400,
        );
      }

      const { data: employee, error: employeeError } = await supabase
        .from('employees')
        .select('id, full_name, employee_code, status, deleted_at')
        .eq('id', input.employeeId)
        .single();
      if (employeeError || !employee || employee.deleted_at || employee.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select an active employee.', 400);
      }

      const { data: activity, error: activityError } = await supabase
        .from('inventory_lab_activities')
        .select('*')
        .eq('id', input.activityId)
        .single();
      if (activityError || !activity || activity.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select an active work type.', 400);
      }
      const usageMode = mapUsageMode((activity as ActivityRow).usage_mode);

      let recipe: InventoryLabRecipe | null = null;
      let runLabel = '';
      let gelPercent: number | null = null;
      let gelVolumeMl: number | null = null;
      let quantityMultiplier = 1;
      let lines: Array<{
        name: string;
        quantityValue?: number | null;
        quantityUnit?: string;
        notes?: string;
        catalogItemId?: string | null;
      }> = input.components ?? [];

      if (usageMode === 'gel') {
        const percent = asFiniteNumber(input.gelPercent);
        const volumeMl = asFiniteNumber(input.gelVolumeMl);
        if (percent === null || volumeMl === null) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Choose agarose percentage and gel volume.',
            400,
          );
        }
        const chart = await this.getGelChart(activity.id);
        if (!chart.percentages.some((value) => value === percent)) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unsupported agarose percentage.', 400);
        }
        if (!chart.volumesMl.some((value) => value === volumeMl)) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unsupported gel volume.', 400);
        }
        const etbrUl = chart.etbrUlByVolumeMl[String(volumeMl)];
        if (etbrUl === undefined) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'EtBr amount is not configured for that volume.',
            400,
          );
        }

        const names: Partial<Record<GelComponentKey, string>> = {};
        const catalogByKey = new Map<GelComponentKey, string | null>();
        for (const component of chart.components) {
          names[component.componentKey] = component.name;
          catalogByKey.set(component.componentKey, component.catalogItemId);
        }
        const computed = buildGelLines({ percent, volumeMl, etbrUl, names });
        const overrides = input.components ?? [];
        lines = computed.map((line, index) => {
          const override =
            overrides.find((row) => row.name.trim().toLowerCase() === line.name.trim().toLowerCase()) ??
            overrides[index];
          let quantityValue = line.quantityValue;
          if (override && override.quantityValue !== undefined && override.quantityValue !== null) {
            const edited = Number(override.quantityValue);
            if (Number.isFinite(edited)) quantityValue = Math.round(edited * 10000) / 10000;
          }
          return {
            name: line.name,
            quantityValue,
            quantityUnit: (override?.quantityUnit ?? line.quantityUnit).trim(),
            notes: '',
            catalogItemId: catalogByKey.get(line.componentKey) ?? null,
          };
        });
        gelPercent = percent;
        gelVolumeMl = volumeMl;
        runLabel = formatGelRunLabel(percent, volumeMl);
      } else if (usageMode === 'pcr') {
        // Freeform PCR: pick master mix + Nx; only master mix deducts from lots.
        if (!input.recipeId) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Employee, work type, and master mix are required.',
            400,
          );
        }
        recipe = await loadRecipe(input.recipeId);
        if (recipe.status !== 'active' || recipe.activityId !== input.activityId) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Select a master mix under PCR reaction.',
            400,
          );
        }
        runLabel = recipe.name;

        const testingTypeId = (input.pcrTestingTypeId ?? '').trim();
        if (testingTypeId) {
          const testingType = findPcrTestingType(testingTypeId);
          if (!testingType) {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              'Unknown PCR testing type.',
              400,
            );
          }
          const existingNotes = (input.notes ?? '').trim();
          const testingNote = `Testing: ${testingType.name}`;
          input.notes = existingNotes
            ? existingNotes.includes(testingNote)
              ? existingNotes
              : `${existingNotes} · ${testingNote}`
            : testingNote;
        }

        const rawNx =
          input.quantityMultiplier === undefined || input.quantityMultiplier === null
            ? 1
            : Number(input.quantityMultiplier);
        if (!Number.isFinite(rawNx) || rawNx <= 0) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Number of reactions must be a positive number (e.g. 1 or 2).',
            400,
          );
        }
        quantityMultiplier = Math.round(rawNx * 10000) / 10000;

        const recipeDefaultVol =
          recipe.finalVolumeValue !== null && recipe.finalVolumeValue !== undefined
            ? Number(recipe.finalVolumeValue)
            : recipe.components[0]?.quantityValue !== null &&
                recipe.components[0]?.quantityValue !== undefined
              ? Number(recipe.components[0].quantityValue)
              : 10;
        const volumePerReactionRaw =
          input.masterMixVolumePerReaction === undefined || input.masterMixVolumePerReaction === null
            ? recipeDefaultVol
            : Number(input.masterMixVolumePerReaction);
        if (!Number.isFinite(volumePerReactionRaw) || volumePerReactionRaw <= 0) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Master mix volume per reaction must be a positive number.',
            400,
          );
        }
        const volumePerReaction = Math.round(volumePerReactionRaw * 10000) / 10000;
        const unitRaw = normalizeManualUnit(
          (
            input.masterMixUnit ||
            recipe.finalVolumeUnit ||
            recipe.components[0]?.quantityUnit ||
            'ul'
          ).trim() || 'ul',
        );
        if (!MANUAL_PROTOCOL_UNITS.has(unitRaw)) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Master mix unit must be one of mg, g, ul, ml, l.',
            400,
          );
        }
        const masterCatalogId =
          recipe.components.find((row) => row.catalogItemId)?.catalogItemId ??
          recipe.components[0]?.catalogItemId ??
          null;
        const masterTotal =
          Math.round(volumePerReaction * quantityMultiplier * 10000) / 10000;

        lines = [
          {
            name: recipe.name,
            quantityValue: masterTotal,
            quantityUnit: unitRaw,
            notes: `${volumePerReaction} ${unitRaw} × ${quantityMultiplier} reactions`,
            catalogItemId: masterCatalogId,
          },
        ];

        const mixture = input.mixtureComponents ?? [];
        if (mixture.length > 40) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'At most 40 mixture components are allowed.',
            400,
          );
        }
        for (const row of mixture) {
          const name = (row.name ?? '').trim();
          if (!name) continue;
          const perReaction =
            row.quantityValue === undefined || row.quantityValue === null
              ? null
              : Number(row.quantityValue);
          if (perReaction !== null && (!Number.isFinite(perReaction) || perReaction < 0)) {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              `Invalid volume for mixture component “${name}”.`,
              400,
            );
          }
          const mixUnit = normalizeManualUnit((row.quantityUnit ?? 'ul').trim() || 'ul');
          if (!MANUAL_PROTOCOL_UNITS.has(mixUnit)) {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              `Unit for “${name}” must be one of mg, g, ul, ml, l.`,
              400,
            );
          }
          const total =
            perReaction === null
              ? null
              : Math.round(perReaction * quantityMultiplier * 10000) / 10000;
          lines.push({
            name,
            quantityValue: total,
            quantityUnit: mixUnit,
            notes:
              perReaction === null
                ? 'Mixture component (no stock deduct)'
                : `${perReaction} ${mixUnit} × ${quantityMultiplier} reactions (no stock deduct)`,
            catalogItemId: null,
          });
        }
      } else {
        if (!input.recipeId) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            usageMode === 'method'
              ? 'Employee, work type, and method are required.'
              : 'Employee, work type, and recipe are required.',
            400,
          );
        }
        recipe = await loadRecipe(input.recipeId);
        if (recipe.status !== 'active' || recipe.activityId !== input.activityId) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            usageMode === 'method'
              ? 'Select a method under that work type.'
              : 'Select a recipe under that work type.',
            400,
          );
        }
        runLabel = recipe.name;

        if (usageMode === 'method') {
          const raw =
            input.quantityMultiplier === undefined || input.quantityMultiplier === null
              ? 1
              : Number(input.quantityMultiplier);
          if (!Number.isFinite(raw) || raw <= 0) {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              'How many must be a positive number (e.g. 1 or 2).',
              400,
            );
          }
          quantityMultiplier = Math.round(raw * 10000) / 10000;
          const overrides = input.components ?? [];
          lines = recipe.components.map((component, index) => {
            const override =
              overrides.find(
                (row) => row.name.trim().toLowerCase() === component.name.trim().toLowerCase(),
              ) ?? overrides[index];
            const base =
              component.quantityValue === null || component.quantityValue === undefined
                ? null
                : Number(component.quantityValue);
            const scaledDefault =
              base === null || !Number.isFinite(base)
                ? null
                : Math.round(base * quantityMultiplier * 10000) / 10000;

            let quantityValue = scaledDefault;
            if (override && override.quantityValue !== undefined && override.quantityValue !== null) {
              const edited = Number(override.quantityValue);
              if (Number.isFinite(edited)) {
                quantityValue = Math.round(edited * 10000) / 10000;
              }
            }

            return {
              name: component.name,
              quantityValue,
              quantityUnit: (override?.quantityUnit ?? component.quantityUnit ?? '').trim(),
              notes: component.notes,
              catalogItemId: component.catalogItemId,
            };
          });
        }
      }

      const itemLabel = nxItemLabel(usageMode);
      if (!lines.length) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `Add at least one component line on this ${itemLabel}.`,
          400,
        );
      }

      const usageLines: InventoryLabUsageComponentLine[] = [];
      for (const line of lines) {
        const name = line.name.trim();
        if (!name) continue;
        const qty =
          line.quantityValue === undefined || line.quantityValue === null
            ? null
            : Number(line.quantityValue);
        if (qty !== null && (!Number.isFinite(qty) || qty < 0)) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, `Invalid quantity for ${name}.`, 400);
        }

        let lotId: string | null = null;
        let qtyDeducted: number | null = null;
        const catalogItemId = line.catalogItemId || null;

        if (catalogItemId && qty !== null && qty > 0) {
          const { data: lotRows, error: lotError } = await supabase
            .from('inventory_lots')
            .select('id, remaining_qty, unit, status, lot_code')
            .eq('central_qr_id', centralRow.id)
            .eq('catalog_item_id', catalogItemId)
            .eq('status', 'active')
            .gt('remaining_qty', 0)
            .order('created_at', { ascending: true });
          if (lotError) {
            throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to find stock for deduction.', 500);
          }
          const lots = (lotRows ?? []) as Array<{
            id: string;
            remaining_qty: number | string;
            unit: string;
            lot_code: string;
          }>;
          let remainingToIssue = qty;
          for (const lot of lots) {
            if (remainingToIssue <= 0) break;
            const available = Number(lot.remaining_qty);
            const take = Math.min(available, remainingToIssue);
            if (take <= 0) continue;
            const { error: rpcError } = await supabase.rpc('inventory_issue_lot', {
              p_lot_id: lot.id,
              p_qty: take,
              p_employee_id: input.employeeId,
              p_notes: scalesWithNx(usageMode)
                ? `Lab usage · ${activity.name} · ${runLabel} · ${quantityMultiplier}X`
                : `Lab usage · ${activity.name} · ${runLabel}`,
              p_created_by: null,
              p_prep_session_id: null,
            });
            if (rpcError) {
              throw new AppError(
                API_ERROR_CODES.VALIDATION_ERROR,
                rpcError.message || `Could not deduct ${name} from ${lot.lot_code}.`,
                400,
              );
            }
            if (!lotId) lotId = lot.id;
            remainingToIssue = Math.round((remainingToIssue - take) * 10000) / 10000;
          }
          if (remainingToIssue > 0) {
            throw new AppError(
              API_ERROR_CODES.VALIDATION_ERROR,
              `Not enough stock for ${name} under Inside lab (need ${qty}, short ${remainingToIssue}).`,
              400,
            );
          }
          qtyDeducted = qty;
        }

        usageLines.push({
          name,
          quantityValue: qty,
          quantityUnit: (line.quantityUnit ?? '').trim(),
          notes: (line.notes ?? '').trim(),
          catalogItemId,
          lotId,
          qtyDeducted,
        });
      }

      if (!usageLines.length) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Add at least one named component.', 400);
      }

      let outputLotId: string | null = null;
      let outputLotCode: string | null = null;
      if (usageMode === 'recipe' && recipe?.createsOutputLot) {
        if (!recipe.outputCatalogItemId) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'This recipe creates an output lot but has no output catalog item. Ask Inventory Manager to set one.',
            400,
          );
        }
        const outputQty =
          input.outputQty !== undefined && input.outputQty !== null
            ? Number(input.outputQty)
            : recipe.finalVolumeValue;
        if (outputQty === null || !Number.isFinite(outputQty) || outputQty <= 0) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Output quantity is required when creating a reagent lot.',
            400,
          );
        }

        const { data: catalog, error: catalogError } = await supabase
          .from('inventory_catalog_items')
          .select('id, unit, default_qty_chips, status')
          .eq('id', recipe.outputCatalogItemId)
          .single();
        if (catalogError || !catalog || catalog.status !== 'active') {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Output catalog item is invalid.', 400);
        }

        const { data: location } = await supabase
          .from('inventory_locations')
          .select('id')
          .eq('status', 'active')
          .order('name')
          .limit(1)
          .maybeSingle();
        if (!location) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'No active location to store the output lot.', 400);
        }

        const lotCode = newLotCode();
        const chips = Array.isArray(catalog.default_qty_chips) ? catalog.default_qty_chips : [];
        const { data: insertedLot, error: lotInsertError } = await supabase
          .from('inventory_lots')
          .insert({
            lot_code: lotCode,
            qr_token: newQrToken(),
            catalog_item_id: recipe.outputCatalogItemId,
            location_id: location.id,
            central_qr_id: centralRow.id,
            supplier_name: 'Lab prep',
            supplier_type: 'internal',
            purchase_date: new Date().toISOString().slice(0, 10),
            received_qty: outputQty,
            remaining_qty: outputQty,
            unit: (recipe.finalVolumeUnit || catalog.unit || 'mL').trim(),
            total_cost: 0,
            component_cost_total: 0,
            origin: 'prep',
            counts_toward_purchase_expense: false,
            qty_chips: chips,
            notes: `Inside lab · ${recipe.name} · ${employee.full_name}`,
            received_by: input.employeeId,
            status: 'active',
          })
          .select('id, lot_code')
          .single();
        if (lotInsertError || !insertedLot) {
          throw new AppError(
            API_ERROR_CODES.INTERNAL_ERROR,
            lotInsertError?.message ?? 'Failed to create output reagent lot.',
            500,
          );
        }
        await supabase.from('inventory_movements').insert({
          lot_id: insertedLot.id,
          movement_type: 'receive',
          qty: outputQty,
          qty_before: 0,
          qty_after: outputQty,
          unit: (recipe.finalVolumeUnit || catalog.unit || 'mL').trim(),
          employee_id: input.employeeId,
          notes: `Lab recipe output · ${recipe.name}`,
          created_by: null,
        });
        outputLotId = insertedLot.id;
        outputLotCode = insertedLot.lot_code;
      }

      const { data: submission, error: submissionError } = await supabase
        .from('inventory_lab_usage_submissions')
        .insert({
          central_qr_id: centralRow.id,
          activity_id: activity.id,
          recipe_id: recipe?.id ?? null,
          employee_id: input.employeeId,
          recipe_name: runLabel,
          activity_name: activity.name,
          components_snapshot: usageLines,
          output_lot_id: outputLotId,
          quantity_multiplier: quantityMultiplier,
          gel_percent: gelPercent,
          gel_volume_ml: gelVolumeMl,
          notes:
            (input.notes ?? '').trim() ||
            (scalesWithNx(usageMode)
              ? `${quantityMultiplier}X`
              : usageMode === 'gel'
                ? runLabel
                : ''),
        })
        .select('id')
        .single();
      if (submissionError || !submission) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          submissionError?.message ?? 'Usage deducted but submission log failed.',
          500,
        );
      }

      await writeAuditLog(supabase, {
        actorId: null,
        action: 'inventory_lab.usage_submit',
        entityType: 'inventory_lab_usage_submission',
        entityId: submission.id,
        newValues: {
          activity: activity.name,
          recipe: runLabel,
          gelPercent,
          gelVolumeMl,
          employeeId: input.employeeId,
          outputLotCode,
          componentCount: usageLines.length,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return {
        id: submission.id,
        activityName: activity.name,
        recipeName: runLabel,
        employeeName: employee.full_name,
        employeeCode: employee.employee_code,
        outputLotCode,
        components: usageLines,
      };
    },

    /** Active catalog items for Manual protocol component picker (Inside lab QR only). */
    async listPublicLabCatalog(centralQrToken: string): Promise<InventoryPublicLabCatalogItem[]> {
      const token = centralQrToken.trim();
      if (!token) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Unknown usage area.', 404);
      }
      const { data: centralRow, error: centralError } = await supabase
        .from('inventory_central_qrs')
        .select('id, kind, status')
        .eq('qr_token', token)
        .single();
      if (centralError || !centralRow) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Unknown usage area.', 404);
      }
      if (centralRow.status !== 'active' || centralRow.kind !== 'inside_lab') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Catalog picker is only available on the Inside lab QR.',
          400,
        );
      }

      const { data, error } = await supabase
        .from('inventory_catalog_items')
        .select('id, name, brand_name, catalog_number, unit, status, inventory_categories(name)')
        .eq('status', 'active')
        .order('name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list catalog items.', 500);
      }

      return ((data ?? []) as Array<{
        id: string;
        name: string;
        brand_name: string | null;
        catalog_number: string | null;
        unit: string;
        inventory_categories?: { name: string } | { name: string }[] | null;
      }>).map((row) => {
        const category = Array.isArray(row.inventory_categories)
          ? row.inventory_categories[0]
          : row.inventory_categories;
        return {
          id: row.id,
          name: row.name,
          brandName: (row.brand_name ?? '').trim(),
          catalogNumber: (row.catalog_number ?? '').trim(),
          categoryName: category?.name ?? '',
          unit: row.unit,
        };
      });
    },

    /**
     * R&D Manual protocol: create a new work type (method mode) + method from the
     * freeform component list, then record this run (1X) with stock deduct.
     */
    async submitManualProtocol(
      centralQrToken: string,
      input: {
        employeeId: string;
        protocolName: string;
        components: Array<{
          catalogItemId: string;
          quantityValue: number;
          quantityUnit: string;
        }>;
        notes?: string;
      },
      meta: RequestMeta = {},
    ): Promise<InventoryLabManualUsageResult> {
      const protocolName = (input.protocolName ?? '').trim();
      if (!protocolName) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Protocol name is required.', 400);
      }
      if (protocolName.length > 120) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Protocol name must be at most 120 characters.',
          400,
        );
      }

      const rawComponents = input.components ?? [];
      if (!rawComponents.length) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Add at least one component from the catalog.',
          400,
        );
      }
      if (rawComponents.length > 40) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'At most 40 components are allowed.', 400);
      }

      const catalogIds = [...new Set(rawComponents.map((row) => row.catalogItemId.trim()).filter(Boolean))];
      if (catalogIds.length !== rawComponents.length) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Each component must be chosen from the catalog.',
          400,
        );
      }

      const { data: catalogRows, error: catalogError } = await supabase
        .from('inventory_catalog_items')
        .select('id, name, unit, status')
        .in('id', catalogIds);
      if (catalogError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load catalog items.', 500);
      }
      const catalogById = new Map(
        ((catalogRows ?? []) as Array<{ id: string; name: string; unit: string; status: string }>).map(
          (row) => [row.id, row],
        ),
      );
      if (catalogById.size !== catalogIds.length) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'One or more components are not valid catalog items.',
          400,
        );
      }
      for (const row of catalogById.values()) {
        if (row.status !== 'active') {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            `Catalog item “${row.name}” is inactive.`,
            400,
          );
        }
      }

      const componentLines: Array<{
        name: string;
        quantityValue: number;
        quantityUnit: string;
        catalogItemId: string;
        sortOrder: number;
      }> = [];
      for (let index = 0; index < rawComponents.length; index += 1) {
        const row = rawComponents[index]!;
        const catalog = catalogById.get(row.catalogItemId.trim());
        if (!catalog) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unknown catalog component.', 400);
        }
        const qty = Number(row.quantityValue);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            `Volume for “${catalog.name}” must be a positive number.`,
            400,
          );
        }
        const unit = (row.quantityUnit ?? '').trim().toLowerCase();
        if (!MANUAL_PROTOCOL_UNITS.has(unit)) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            `Unit for “${catalog.name}” must be one of mg, g, ul, ml, l.`,
            400,
          );
        }
        componentLines.push({
          name: catalog.name,
          quantityValue: Math.round(qty * 10000) / 10000,
          quantityUnit: unit,
          catalogItemId: catalog.id,
          sortOrder: (index + 1) * 10,
        });
      }

      const { data: existingActivity } = await supabase
        .from('inventory_lab_activities')
        .select('id')
        .ilike('name', protocolName)
        .maybeSingle();
      if (existingActivity) {
        throw new AppError(
          API_ERROR_CODES.CONFLICT,
          `A work type named “${protocolName}” already exists. Pick it from the list and run with Nx.`,
          409,
        );
      }

      const { data: sortRow } = await supabase
        .from('inventory_lab_activities')
        .select('sort_order')
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextSort =
        sortRow && Number.isFinite(Number((sortRow as { sort_order: number }).sort_order))
          ? Math.trunc(Number((sortRow as { sort_order: number }).sort_order)) + 10
          : 1000;

      const { data: activityInserted, error: activityError } = await supabase
        .from('inventory_lab_activities')
        .insert({
          name: protocolName,
          description:
            'R&D protocol saved from Manual. Choose this work type, set how many (Nx), then submit.',
          sort_order: nextSort,
          status: 'active',
          usage_mode: 'method',
        })
        .select('id, name')
        .single();
      if (activityError || !activityInserted) {
        if (activityError?.code === '23505') {
          throw new AppError(
            API_ERROR_CODES.CONFLICT,
            `A work type named “${protocolName}” already exists. Pick it from the list and run with Nx.`,
            409,
          );
        }
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          activityError?.message ?? 'Failed to create work type.',
          500,
        );
      }

      const activityId = (activityInserted as { id: string }).id;
      const { data: recipeInserted, error: recipeError } = await supabase
        .from('inventory_lab_recipes')
        .insert({
          activity_id: activityId,
          name: protocolName,
          final_volume_value: null,
          final_volume_unit: '',
          notes: 'Created from Inside lab Manual protocol.',
          sort_order: 10,
          status: 'active',
          creates_output_lot: false,
          output_catalog_item_id: null,
          sop_file_id: null,
        })
        .select('id')
        .single();
      if (recipeError || !recipeInserted) {
        await supabase.from('inventory_lab_activities').delete().eq('id', activityId);
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          recipeError?.message ?? 'Failed to create protocol method.',
          500,
        );
      }

      const recipeId = (recipeInserted as { id: string }).id;
      const { error: componentError } = await supabase.from('inventory_lab_recipe_components').insert(
        componentLines.map((line) => ({
          recipe_id: recipeId,
          name: line.name,
          quantity_value: line.quantityValue,
          quantity_unit: line.quantityUnit,
          notes: 'Per 1X run',
          sort_order: line.sortOrder,
          catalog_item_id: line.catalogItemId,
        })),
      );
      if (componentError) {
        await supabase.from('inventory_lab_activities').delete().eq('id', activityId);
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          componentError.message ?? 'Failed to save protocol components.',
          500,
        );
      }

      await writeAuditLog(supabase, {
        actorId: null,
        action: 'inventory_lab.manual_protocol_create',
        entityType: 'inventory_lab_activity',
        entityId: activityId,
        newValues: {
          protocolName,
          recipeId,
          componentCount: componentLines.length,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      // Keep the new work type even if this run's deduct fails — staff can retry via Nx.
      const usage = await this.submitPublicUsage(
        centralQrToken,
        {
          employeeId: input.employeeId,
          activityId,
          recipeId,
          quantityMultiplier: 1,
          notes: (input.notes ?? '').trim() || `Manual protocol · ${protocolName}`,
          components: componentLines.map((line) => ({
            name: line.name,
            quantityValue: line.quantityValue,
            quantityUnit: line.quantityUnit,
            notes: 'Per 1X run',
            catalogItemId: line.catalogItemId,
          })),
        },
        meta,
      );

      return {
        ...usage,
        activityId,
        recipeId,
      };
    },
  };
}
