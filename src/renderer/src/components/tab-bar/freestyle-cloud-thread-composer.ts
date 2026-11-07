import { useCallback } from 'react'
import { FREESTYLE_CLOUD_RECIPE_ID } from '../../../../shared/freestyle-cloud-recipe'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { useAppStore } from '@/store'

type LaunchAgentRow = (
  row: NewTabAgentMenuRow,
  draft?: AgentPickerDraft,
  pickerEntry?: AgentPickerEntry
) => boolean | Promise<boolean>

export function useFreestyleCloudThreadLaunch(
  workspaceId: string,
  prompt: string | undefined,
  keepsPrompt: boolean,
  launch: LaunchAgentRow
): LaunchAgentRow {
  return useCallback(
    (row, draft, pickerEntry) => {
      if (keepsPrompt || (row.kind !== 'chat' && row.kind !== 'cli')) {
        return launch(row, draft, pickerEntry)
      }
      const cloudThread = openFreestyleCloudThreadComposer(
        workspaceId,
        row,
        prompt ?? draft?.prompt
      )
      return cloudThread
        ? cloudThread.then((opened) => opened || launch(row, draft, pickerEntry))
        : launch(row, draft, pickerEntry)
    },
    [keepsPrompt, launch, prompt, workspaceId]
  )
}

function openFreestyleCloudThreadComposer(
  workspaceId: string,
  row: Extract<NewTabAgentMenuRow, { kind: 'chat' | 'cli' }>,
  prompt?: string
): Promise<boolean> | null {
  if (!window.api?.ephemeralVm) {
    return null
  }
  const state = useAppStore.getState()
  const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, workspaceId)
  const environment = state.runtimeEnvironments.find((entry) => entry.id === environmentId)
  if (environment?.source !== 'ephemeral-vm') {
    return null
  }

  return window.api.ephemeralVm.listRuntimes().then(
    (runtimes) => {
      const runtime = runtimes.find(
        (entry) =>
          entry.runtimeEnvironmentId === environmentId &&
          entry.recipeId === FREESTYLE_CLOUD_RECIPE_ID
      )
      if (!runtime) {
        return false
      }
      if (runtime.repoId && state.settings?.experimentalEphemeralVms) {
        state.openModal('new-workspace-composer', {
          initialRepoId: runtime.repoId,
          initialEphemeralVmRecipeId: runtime.recipeId,
          cloudThreadDraft: {
            agent: row.agent,
            surface: row.kind === 'chat' ? 'chat' : 'terminal',
            prompt
          }
        })
        return true
      }
      reportCloudThreadComposerFailure()
      return true
    },
    () => {
      reportCloudThreadComposerFailure()
      return true
    }
  )
}

function reportCloudThreadComposerFailure(): void {
  toast.error(
    translate(
      'components.tabBar.cloudThreadComposer.openFailed',
      'Open the source project with Cloud VM enabled to start another cloud thread.'
    )
  )
}
