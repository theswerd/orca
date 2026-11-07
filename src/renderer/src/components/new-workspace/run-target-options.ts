import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { FREESTYLE_CLOUD_RECIPE_ID } from '../../../../shared/freestyle-cloud-recipe'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import {
  getProjectHostSetupSelectionKey,
  type NeedsSetupProjectHostOption,
  type ProjectHostSetupOption,
  type ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import { translate } from '@/i18n/i18n'
import { boundHostList } from '@/components/host-picker/bounded-host-list'

export type EphemeralVmRecipeOption = NonNullable<OrcaHooks['environmentRecipes']>[number]

export const RUN_TARGET_ADD_HOST_KEY = 'add-host'
export const RUN_TARGET_RECIPES_KEY = 'per-workspace-env'

/** Hosts and Orca Cloud commit directly. The other recipes and Add host open submenus. */
export type RunTargetRowModel =
  | { key: string; kind: 'ready'; option: ReadyProjectHostSetupOption }
  | { key: string; kind: 'needs-setup'; option: NeedsSetupProjectHostOption }
  | { key: typeof FREESTYLE_CLOUD_RECIPE_ID; kind: 'cloud'; recipe: EphemeralVmRecipeOption }
  | { key: typeof RUN_TARGET_RECIPES_KEY; kind: 'recipes' }
  | { key: typeof RUN_TARGET_ADD_HOST_KEY; kind: 'add-host' }

export function getEphemeralVmLabel(): string {
  return translate(
    'auto.components.NewWorkspaceComposerCard.ephemeralVm',
    'Per-Workspace Environment'
  )
}

export function getRecipeCommandDisplay(command: string): string {
  const trimmed = command.trim()
  const quoted = trimmed.match(/^"([^"]+)"/) ?? trimmed.match(/^'([^']+)'/)
  return quoted?.[1] ?? trimmed.split(/\s+/)[0] ?? trimmed
}

export function getRecipeDestroyLabel(recipe: EphemeralVmRecipeOption): string {
  if (recipe.destroyDisabled) {
    return translate('auto.components.NewWorkspaceComposerCard.destroyDisabled', 'destroy disabled')
  }
  if (recipe.destroy) {
    return translate(
      'auto.components.NewWorkspaceComposerCard.destroyConfigured',
      'destroy configured'
    )
  }
  return translate('auto.components.NewWorkspaceComposerCard.noDestroyConfigured', 'no destroy')
}

export function getRecipeDetail(recipe: EphemeralVmRecipeOption): string {
  if (recipe.id === FREESTYLE_CLOUD_RECIPE_ID) {
    return translate('components.newWorkspace.orcaCloudDetail', 'A fresh VM for this worktree')
  }
  return `${getRecipeCommandDisplay(recipe.create)} · ${getRecipeDestroyLabel(recipe)}`
}

function matches(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query)
}

/** Show ready hosts first; bound and rank unready hosts, which may include every configured SSH host. */
function buildHostRows(
  hostOptions: readonly ProjectHostSetupOption[],
  query: string
): { rows: RunTargetRowModel[]; hiddenHostCount: number } {
  const hostMatches = (option: ProjectHostSetupOption): boolean =>
    query === '' ||
    matches(option.label, query) ||
    matches(option.detail, query) ||
    (option.kind === 'ready' && matches(option.path, query))

  const ready = hostOptions.filter(
    (option): option is ReadyProjectHostSetupOption =>
      option.kind === 'ready' && hostMatches(option)
  )
  const needsSetup = boundHostList(
    hostOptions
      .filter(
        (option): option is NeedsSetupProjectHostOption =>
          option.kind === 'needs-setup' && hostMatches(option)
      )
      .map((option) => ({
        id: getProjectHostSetupSelectionKey(option),
        label: option.label,
        searchText: option.detail,
        option
      })),
    // Why the query again: ranks an exact name first so typing it always reaches the host.
    { query }
  )
  const rows: RunTargetRowModel[] = [
    ...ready.map((option) => ({
      key: `host:${getProjectHostSetupSelectionKey(option)}`,
      kind: 'ready' as const,
      option
    })),
    ...needsSetup.shown.map(({ id, option }) => ({
      key: `needs:${id}`,
      kind: 'needs-setup' as const,
      option
    }))
  ]
  return { rows, hiddenHostCount: needsSetup.hiddenCount }
}

function matchRecipes(
  recipes: readonly EphemeralVmRecipeOption[],
  query: string
): EphemeralVmRecipeOption[] {
  return recipes.filter(
    (recipe) =>
      query === '' ||
      matches(recipe.name, query) ||
      matches(getEphemeralVmLabel(), query) ||
      matches(recipe.description ?? '', query)
  )
}

function buildSubmenuRows(hasRecipes: boolean, hasAddHost: boolean): RunTargetRowModel[] {
  const rows: RunTargetRowModel[] = []
  if (hasRecipes) {
    rows.push({ key: RUN_TARGET_RECIPES_KEY, kind: 'recipes' })
  }
  if (hasAddHost) {
    rows.push({ key: RUN_TARGET_ADD_HOST_KEY, kind: 'add-host' })
  }
  return rows
}

/** Filter host/recipe rows but always keep Add host reachable; other submenus require matching contents. */
export function buildRunTargetRows({
  hostOptions,
  recipes,
  query,
  hasAddHost
}: {
  hostOptions: readonly ProjectHostSetupOption[]
  recipes: readonly EphemeralVmRecipeOption[]
  query: string
  hasAddHost: boolean
}): {
  rows: RunTargetRowModel[]
  matchedRecipes: EphemeralVmRecipeOption[]
  /** Hosts the row limit left out; typing narrows them in. */
  hiddenHostCount: number
} {
  const trimmed = query.trim().toLowerCase()
  const matchingRecipes = matchRecipes(recipes, trimmed)
  const cloudRecipe = matchingRecipes.find((recipe) => recipe.id === FREESTYLE_CLOUD_RECIPE_ID)
  const matchedRecipes = matchingRecipes.filter((recipe) => recipe.id !== FREESTYLE_CLOUD_RECIPE_ID)
  const hostRows = buildHostRows(hostOptions, trimmed)
  const rows = hostRows.rows
  if (cloudRecipe) {
    const localRow = rows.findIndex(
      (row) =>
        (row.kind === 'ready' || row.kind === 'needs-setup') &&
        row.option.hostId === LOCAL_EXECUTION_HOST_ID
    )
    rows.splice(localRow + 1, 0, {
      key: FREESTYLE_CLOUD_RECIPE_ID,
      kind: 'cloud',
      recipe: cloudRecipe
    })
  }
  rows.push(...buildSubmenuRows(matchedRecipes.length > 0, hasAddHost))
  return { rows, matchedRecipes, hiddenHostCount: hostRows.hiddenHostCount }
}
