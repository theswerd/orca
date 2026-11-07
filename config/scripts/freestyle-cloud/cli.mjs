import { createApi, readConfig, deleteIfPresent } from './api.mjs'
import { createThread, runThreadLifecycle } from './thread.mjs'
import { createTemplate, parseResources } from './template.mjs'
import { prepareProject, projectUrl } from './project.mjs'

const usage = `Usage:
  node config/scripts/freestyle-cloud/cli.mjs pool-list
  node config/scripts/freestyle-cloud/cli.mjs pool-create MANAGER CPU MEMORY_MIB STORAGE_MIB
  node config/scripts/freestyle-cloud/cli.mjs pool-delete POOL_ID
  node config/scripts/freestyle-cloud/cli.mjs template-create BASE_ID CPU MEMORY_MIB STORAGE_MIB
  node config/scripts/freestyle-cloud/cli.mjs doctor
  node /path/to/orca/config/scripts/freestyle-cloud/cli.mjs project-prepare
    Run project-prepare from the Git project checkout.
Orca runs create, suspend, resume and destroy through the workspace recipe.`

const [mode, ...args] = process.argv.slice(2)
if (!mode || mode === '--help') {
  console.log(usage)
} else {
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  try {
    const config = readConfig()
    const api = createApi(config)
    const result = await run(api, config, controller.signal)
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

async function run(api, config, signal) {
  switch (mode) {
    case 'pool-list':
      return api('GET', 'pools', { signal })
    case 'pool-create': {
      const [manager, ...sizes] = args
      if (!/^[a-zA-Z0-9-]+$/.test(manager || '')) {
        throw new Error(usage)
      }
      return api('POST', 'pools', {
        signal,
        headers: { 'X-Freestyle-Target-Manager': manager },
        body: parseResources(sizes)
      })
    }
    case 'pool-delete':
      if (!/^pool-[a-zA-Z0-9_-]+$/.test(args[0] || '') || args.length !== 1) {
        throw new Error(usage)
      }
      await deleteIfPresent(api, `pools/${args[0]}`, { signal })
      return { ok: true }
    case 'template-create': {
      const [base, ...sizes] = args
      return createTemplate(api, config.FREESTYLE_ORCA_POOL_ID, base, parseResources(sizes), signal)
    }
    case 'project-prepare': {
      const poolId = config.FREESTYLE_ORCA_POOL_ID
      const baseId = config.FREESTYLE_ORCA_SNAPSHOT_ID
      if (!poolId || !baseId) {
        throw new Error('Set FREESTYLE_ORCA_POOL_ID and FREESTYLE_ORCA_SNAPSHOT_ID.')
      }
      return prepareProject(api, poolId, baseId, projectUrl({}), signal)
    }
    case 'doctor': {
      const poolId = config.FREESTYLE_ORCA_POOL_ID
      const snapshotId = config.FREESTYLE_ORCA_SNAPSHOT_ID
      if (!poolId || !snapshotId) {
        throw new Error('Set FREESTYLE_ORCA_POOL_ID and FREESTYLE_ORCA_SNAPSHOT_ID.')
      }
      const [pool, snapshot] = await Promise.all([
        api('GET', `pools/${encodeURIComponent(poolId)}`, { signal }),
        api('GET', `snapshots/${encodeURIComponent(snapshotId)}`, { signal })
      ])
      return { pool, snapshotId: snapshot.id }
    }
    case 'create':
      return createThread(api, config, signal)
    case 'suspend':
    case 'resume':
    case 'destroy':
      return runThreadLifecycle(api, mode, signal)
    default:
      throw new Error(usage)
  }
}
