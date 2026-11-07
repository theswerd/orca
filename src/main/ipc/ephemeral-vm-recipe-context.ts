import type { Store } from '../persistence/loading-store/store'
import { loadHooks } from '../workspace-hooks/hooks'
import type { EphemeralVmRecipeDoctorResult } from '../../shared/ephemeral-vm-recipes'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { isFolderRepo, isGitRepoKind } from '../../shared/repo-kind'
import { FREESTYLE_CLOUD_RECIPE_ID } from '../../shared/freestyle-cloud-recipe'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import {
  EphemeralVmFailureError,
  ephemeralVmFailure,
  type EphemeralVmFailure
} from '../../shared/ephemeral-vm-failure-copy'

export type EphemeralVmRecipeListResult = {
  status: 'ok' | 'error'
  repoPath: string | null
  recipes: OrcaVmRecipe[]
  diagnostics: NonNullable<ReturnType<typeof loadHooks>>['environmentRecipeDiagnostics']
  message?: string
  messageCode?: string
  messageParams?: Record<string, string | number>
}

export type EphemeralVmRecipeCatalogEntry = {
  repoId: string
  repoName: string
  repoPath: string
  recipes: OrcaVmRecipe[]
  diagnostics: NonNullable<ReturnType<typeof loadHooks>>['environmentRecipeDiagnostics']
}

export type RecipeRepoResult =
  | { ok: true; repo: Exclude<ReturnType<Store['getRepo']>, null | undefined> }
  | {
      ok: false
      message: string
      failure: EphemeralVmFailure
      doctor: (recipeId: string) => EphemeralVmRecipeDoctorResult
    }

export function listRecipes(
  store: Store,
  repoId: string,
  desktopRecipes: readonly OrcaVmRecipe[] = []
): EphemeralVmRecipeListResult {
  const repo = store.getRepo(repoId)
  if (!repo || isFolderRepo(repo)) {
    return failedRecipeList(null, ephemeralVmFailure('repoNotFound', { repoId }))
  }
  if (repo.connectionId) {
    return failedRecipeList(repo.path, ephemeralVmFailure('remoteRepoUnsupported'))
  }
  const hooks = loadHooks(repo.path)
  return {
    status: 'ok',
    repoPath: repo.path,
    recipes: combineEphemeralVmRecipes(hooks?.environmentRecipes ?? [], desktopRecipes),
    diagnostics: hooks?.environmentRecipeDiagnostics ?? []
  }
}

export function listRecipeCatalog(
  store: Store,
  desktopRecipes: readonly OrcaVmRecipe[] = []
): EphemeralVmRecipeCatalogEntry[] {
  return store
    .getRepos()
    .filter((repo) => isGitRepoKind(repo) && !isFolderRepo(repo) && !repo.connectionId)
    .map((repo) => {
      const hooks = loadHooks(repo.path)
      return {
        repoId: repo.id,
        repoName: repo.displayName,
        repoPath: repo.path,
        recipes: combineEphemeralVmRecipes(hooks?.environmentRecipes ?? [], desktopRecipes),
        diagnostics: hooks?.environmentRecipeDiagnostics ?? []
      }
    })
    .filter((entry) => entry.recipes.length > 0 || entry.diagnostics.length > 0)
}

export function getRecipeRepo(store: Store, repoId: string): RecipeRepoResult {
  const repo = store.getRepo(repoId)
  if (!repo || isFolderRepo(repo)) {
    return failedRecipeRepo(null, ephemeralVmFailure('repoNotFound', { repoId }))
  }
  if (repo.connectionId) {
    return failedRecipeRepo(repo.path, ephemeralVmFailure('remoteRepoUnsupported'))
  }
  return { ok: true, repo }
}

export function getRuntimeRecipeContext(
  store: Store,
  userDataPath: string,
  runtimeId: string
): {
  runtime: EphemeralVmRuntimeRecord
  repo: Extract<RecipeRepoResult, { ok: true }>
  recipe: OrcaVmRecipe
} {
  const runtime = listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === runtimeId)
  if (!runtime) {
    throw new EphemeralVmFailureError(ephemeralVmFailure('runtimeNotFound', { runtimeId }))
  }
  if (!runtime.repoId) {
    throw new EphemeralVmFailureError(ephemeralVmFailure('runtimeRepoMissing', { runtimeId }))
  }
  const repo = getRecipeRepo(store, runtime.repoId)
  if (!repo.ok) {
    throw new EphemeralVmFailureError(repo.failure)
  }
  // Legacy runtimes lack snapshots; never substitute a newer same-ID plugin recipe for their repo-owned recipe.
  const recipe =
    runtime.recipe ??
    (loadHooks(repo.repo.path)?.environmentRecipes ?? []).find(
      (entry) => entry.id === runtime.recipeId
    )
  if (!recipe) {
    throw new EphemeralVmFailureError(
      ephemeralVmFailure('recipeNotFound', { recipeId: runtime.recipeId })
    )
  }
  return { runtime, repo, recipe }
}

export function resolveRecipeForRepo(
  repoPath: string,
  recipeId: string,
  desktopRecipes: readonly OrcaVmRecipe[] = []
): OrcaVmRecipe | null {
  return (
    combineEphemeralVmRecipes(loadHooks(repoPath)?.environmentRecipes ?? [], desktopRecipes).find(
      (recipe) => recipe.id === recipeId
    ) ?? null
  )
}

/** Keep the built-in cloud action bound to the app's recipe. Other project recipes can shadow plugins. */
export function combineEphemeralVmRecipes(
  repoRecipes: readonly OrcaVmRecipe[],
  desktopRecipes: readonly OrcaVmRecipe[]
): OrcaVmRecipe[] {
  const cloudRecipe = desktopRecipes.find((recipe) => recipe.id === FREESTYLE_CLOUD_RECIPE_ID)
  const projectRecipes = cloudRecipe
    ? repoRecipes.filter((recipe) => recipe.id !== cloudRecipe.id)
    : repoRecipes
  const repoIds = new Set(projectRecipes.map((recipe) => recipe.id))
  return [...projectRecipes, ...desktopRecipes.filter((recipe) => !repoIds.has(recipe.id))]
}

function failedRecipeRepo(repoPath: string | null, failure: EphemeralVmFailure): RecipeRepoResult {
  const message = failure.error
  return {
    ok: false,
    message,
    failure,
    doctor: (recipeId) => ({
      recipeId,
      repoPath: repoPath ?? '',
      ok: false,
      checks: [
        {
          id: 'recipe.execution_target',
          status: 'fail',
          message,
          remediation: 'Use a local repo checkout for the recipe.'
        }
      ]
    })
  }
}

function failedRecipeList(
  repoPath: string | null,
  failure: EphemeralVmFailure
): EphemeralVmRecipeListResult {
  return {
    status: 'error',
    repoPath,
    recipes: [],
    diagnostics: [],
    message: failure.error,
    ...(failure.errorCode ? { messageCode: failure.errorCode } : {}),
    ...(failure.errorParams ? { messageParams: failure.errorParams } : {})
  }
}
