import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canManageLab, type RequestMeta } from './access';
import type {
  InventoryLabActivity,
  InventoryLabRecipe,
  InventoryLabRecipeComponent,
  InventoryStatus,
} from './types';

type ActivityRow = {
  id: string;
  name: string;
  description: string;
  sort_order: number;
  status: InventoryStatus;
  created_at: string;
  updated_at: string;
};

type RecipeRow = {
  id: string;
  activity_id: string;
  name: string;
  final_volume_value: number | string | null;
  final_volume_unit: string;
  notes: string;
  sort_order: number;
  status: InventoryStatus;
  created_at: string;
  updated_at: string;
  inventory_lab_activities?: { name: string } | { name: string }[] | null;
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

function mapRecipe(row: RecipeRow, components: InventoryLabRecipeComponent[] = []): InventoryLabRecipe {
  const activity = one(row.inventory_lab_activities ?? null);
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
    components,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const RECIPE_SELECT = '*, inventory_lab_activities(name)';
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

  async function loadRecipe(id: string): Promise<InventoryLabRecipe> {
    const { data, error } = await supabase
      .from('inventory_lab_recipes')
      .select(RECIPE_SELECT)
      .eq('id', id)
      .single();
    if (error || !data) {
      throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Recipe not found.', 404);
    }
    const components = await loadComponents(id);
    return mapRecipe(data as RecipeRow, components);
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
      return activities.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        sortOrder: row.sort_order,
        status: row.status,
        recipeCount: counts.get(row.id) ?? 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },

    async createActivity(
      actor: RequestUser,
      input: { name: string; description?: string; sortOrder?: number },
      meta: RequestMeta,
    ): Promise<InventoryLabActivity> {
      if (!canManageLab(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage lab recipes.', 403);
      }
      const name = input.name.trim();
      if (!name) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Activity name is required.', 400);
      }
      const { data, error } = await supabase
        .from('inventory_lab_activities')
        .insert({
          name,
          description: (input.description ?? '').trim(),
          sort_order: Number.isFinite(input.sortOrder) ? Math.trunc(input.sortOrder!) : 100,
          status: 'active',
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
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_lab_activity.create',
        entityType: 'inventory_lab_activity',
        entityId: row.id,
        newValues: { name: row.name },
        ...meta,
      });
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        sortOrder: row.sort_order,
        status: row.status,
        recipeCount: 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    async updateActivity(
      actor: RequestUser,
      id: string,
      input: { name?: string; description?: string; sortOrder?: number; status?: InventoryStatus },
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
        result.push(mapRecipe(row, await loadComponents(row.id)));
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
      return ((data ?? []) as ActivityRow[]).map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        sortOrder: row.sort_order,
        status: row.status,
        recipeCount: 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
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
        result.push(mapRecipe(row, await loadComponents(row.id)));
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
  };
}
