import { randomUUID } from 'node:crypto'
import { vmPath, waitForVm } from './api.mjs'

export function parseResources(sizes) {
  if (
    sizes.length !== 3 ||
    sizes.some((size) => !/^[1-9][0-9]*$/.test(size) || !Number.isSafeInteger(Number(size)))
  ) {
    throw new Error('Supply positive integer CPU, memory MiB and storage MiB values.')
  }
  const [cpu, memory, storage] = sizes.map(Number)
  return { cpu, memory, storage }
}

export async function createTemplate(api, poolId, base, resources, signal) {
  if (
    !/^pool-[a-zA-Z0-9_-]+$/.test(poolId || '') ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(base || '')
  ) {
    throw new Error('Set FREESTYLE_ORCA_POOL_ID and pass the staged virtiofs base ID.')
  }
  const slug = `orca-template-${randomUUID()}`
  console.error(`Creating prepared bootstrap ${slug} in ${poolId}.`)
  const vm = await api('POST', 'vms', {
    signal,
    timeoutMs: 120_000,
    body: {
      slug,
      poolId,
      bsvmm: 'nightly',
      virtiofs: { base, prepare: true, dax: true },
      source: { image: 'file-cow', resources },
      poolLimits: { memoryFloor: 16 },
      firewall: { rules: [] }
    }
  })

  try {
    await waitForVm(api, vm.id, 'running', signal)
    // The prepared runtime must never touch its persistent root before capture.
    const snapshot = await api('POST', `${vmPath(vm.id)}/snapshot`, {
      signal,
      timeoutMs: 120_000,
      body: { slug, displayName: 'Orca Cloud template' }
    })
    console.error(`Captured snapshot ${snapshot.snapshotId}. Stopping bootstrap ${vm.id}.`)
    await api('POST', `${vmPath(vm.id)}/stop`, { signal, body: {}, timeoutMs: 120_000 })
    await waitForVm(api, vm.id, 'stopped', signal)
    return { poolId, snapshotId: snapshot.snapshotId, bootstrapVmId: vm.id }
  } catch (error) {
    console.error(`Inspect bootstrap VM ${vm.id} and snapshot slug ${slug} before retrying.`)
    throw error
  }
}
