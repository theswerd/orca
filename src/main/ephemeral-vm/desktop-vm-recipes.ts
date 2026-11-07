import { app } from 'electron'
import { join } from 'node:path'
import { FREESTYLE_CLOUD_RECIPE_ID } from '../../shared/freestyle-cloud-recipe'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import { quoteShellToken } from '../../shared/ephemeral-vm-recipe-process'
import { getApprovedPluginVmRecipes } from '../plugins/plugin-approved-vm-recipes'
import type { PluginService } from '../plugins/plugin-service'

export async function getDesktopVmRecipes(pluginService?: PluginService): Promise<OrcaVmRecipe[]> {
  const scriptDirectory = app.isPackaged
    ? join(process.resourcesPath, 'freestyle-cloud')
    : join(app.getAppPath(), 'config', 'scripts', 'freestyle-cloud')
  const command = `node ${quoteShellToken(join(scriptDirectory, 'cli.mjs'))}`
  return [
    {
      id: FREESTYLE_CLOUD_RECIPE_ID,
      name: 'Orca Cloud',
      description: 'Create a fresh Freestyle VM for this worktree.',
      checkoutMode: 'orca-worktree',
      create: `${command} create`,
      suspend: `${command} suspend`,
      resume: `${command} resume`,
      destroy: `${command} destroy`
    },
    ...(await getApprovedPluginVmRecipes(pluginService)).filter(
      (recipe) => recipe.id !== FREESTYLE_CLOUD_RECIPE_ID
    )
  ]
}
