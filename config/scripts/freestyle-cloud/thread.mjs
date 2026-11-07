import { createHash } from 'node:crypto'
import { text } from 'node:stream/consumers'
import { deleteIfPresent, execGuest, vmPath, waitForVm } from './api.mjs'
import { serveOrca } from './orcad-launch.mjs'
import {
  findProjectSnapshot,
  PROJECT_ROOT,
  projectAuthentication,
  projectUrl,
  PUBLIC_EGRESS,
  startDisplay
} from './project.mjs'

const ORCA_PORT = 7331
const PROVIDER = 'freestyle-resource-pool'

function threadSlug(instanceId) {
  if (!instanceId) {
    throw new Error('The Orca recipe must supply ORCA_VM_INSTANCE_ID.')
  }
  const hash = createHash('sha256').update(instanceId).digest('hex').slice(0, 32)
  return `orca-thread-${hash}`
}

function requireId(value, prefix, label) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}-[a-zA-Z0-9_-]+$`).test(value)) {
    throw new Error(`Set a valid ${label}.`)
  }
  return value
}

function pairingResult(stdout) {
  let result
  try {
    result = JSON.parse(stdout)
  } catch {
    throw new Error('Orca serve returned invalid recipe JSON.')
  }
  if (
    result?.schemaVersion !== 1 ||
    result.projectRoot !== PROJECT_ROOT ||
    typeof result.pairingCode !== 'string' ||
    !/^orca:\/\/pair(?:\?code=|#)/.test(result.pairingCode)
  ) {
    throw new Error('The guest needs a version of Orca that supports serve --recipe-json.')
  }
  return result
}

async function ownedVm(api, id, slug, signal) {
  const vm = await api('GET', vmPath(id), { signal })
  if (vm.slug !== slug || vm.metadata?.orcaProvider !== PROVIDER) {
    throw new Error(`VM ${id} does not belong to this Orca thread.`)
  }
  return vm
}

async function deleteThread(api, id, slug, signal) {
  try {
    await ownedVm(api, id, slug, signal)
  } catch (error) {
    if (error.status === 404) {
      return
    }
    throw error
  }
  await deleteIfPresent(api, vmPath(id), { signal })
}

export async function createThread(api, config, signal) {
  const slug = threadSlug(config.ORCA_VM_INSTANCE_ID)
  const poolId = requireId(config.FREESTYLE_ORCA_POOL_ID, 'pool', 'FREESTYLE_ORCA_POOL_ID')
  const baseId = requireId(config.FREESTYLE_ORCA_SNAPSHOT_ID, 'sh', 'FREESTYLE_ORCA_SNAPSHOT_ID')
  const repoUrl = projectUrl(config)
  const auth = projectAuthentication(repoUrl)
  const prepared = await findProjectSnapshot(api, poolId, baseId, repoUrl, signal)
  const snapshotId = prepared?.id ?? baseId
  const suffix = config.FREESTYLE_ORCA_DOMAIN_SUFFIX || 'style.dev'
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(suffix)) {
    throw new Error('Set FREESTYLE_ORCA_DOMAIN_SUFFIX to a DNS suffix without a wildcard.')
  }
  const domain = `${slug}.${suffix}`

  let vmId
  console.error(
    prepared ? 'Starting VM from the project snapshot.' : 'Starting VM from the Orca base image.'
  )
  try {
    // The snapshot and pool must share the prepared virtiofs lineage. See Freestyle's
    // docs/file-cow-manager-experiment.md. A failed request can still have created the slug.
    const vm = await api('POST', 'vms', {
      signal,
      timeoutMs: 120_000,
      body: {
        slug,
        displayName: config.ORCA_WORKSPACE_NAME || slug,
        poolId,
        snapshotId,
        poolLimits: { memoryFloor: 16 },
        metadata: { orcaProvider: PROVIDER },
        firewall: PUBLIC_EGRESS,
        tls: {
          rules: [
            {
              action: 'allow',
              domain,
              protocol: 'http',
              source: { public: true },
              destination: { port: ORCA_PORT }
            }
          ]
        }
      }
    })
    vmId = requireId(vm.id, 'vm', 'created VM ID')
    if (vm.state !== 'running') {
      await waitForVm(api, vmId, 'running', signal)
    }
    console.error(
      prepared
        ? 'Fetching repository updates and starting Orca.'
        : 'Cloning the project and starting Orca.'
    )
    const result = await execGuest(api, vmId, signal, {
      env: {
        ...auth.env,
        GIT_TERMINAL_PROMPT: '0',
        ORCA_PROJECT_URL: repoUrl,
        ORCA_PROJECT_ROOT: PROJECT_ROOT,
        ORCA_PAIRING_ADDRESS: `wss://${domain}`,
        ORCA_PORT: String(ORCA_PORT)
      },
      command: [
        'set -eu',
        'orca_umask=$(umask)',
        auth.install,
        prepared
          ? '[ "$(git -C "$ORCA_PROJECT_ROOT" config remote.origin.url)" = "$ORCA_PROJECT_URL" ] || { echo "Project snapshot belongs to a different repository." >&2; exit 1; }'
          : 'git init -q "$ORCA_PROJECT_ROOT" && git -C "$ORCA_PROJECT_ROOT" remote add origin "$ORCA_PROJECT_URL"',
        auth.configure,
        'refresh_project() {',
        '  git -C "$ORCA_PROJECT_ROOT" fetch -q --prune --no-tags origin >&2 &&',
        ...(!prepared
          ? ['  git -C "$ORCA_PROJECT_ROOT" remote set-head origin --auto >&2 &&']
          : []),
        '  git -C "$ORCA_PROJECT_ROOT" checkout -q --detach refs/remotes/origin/HEAD',
        '}',
        ...(prepared ? ['refresh_project &', 'project_refresh_pid=$!'] : ['refresh_project']),
        startDisplay,
        serveOrca,
        'orca_ready=$(serve_orca) || { tail -20 "$HOME/.orca-cloud-serve.log" >&2; exit 1; }',
        ...(prepared ? ['wait "$project_refresh_pid"'] : []),
        'printf "%s\\n" "$orca_ready"'
      ].join('\n')
    })
    if (result.statusCode !== 0) {
      const reason = result.stderr
        ?.trim()
        .replace(/orca:\/\/\S+/g, '[pairing link]')
        .slice(-1800)
      throw new Error(
        `Orca Cloud setup failed in the guest (exit ${result.statusCode}).${reason ? ` ${reason}` : ''}`
      )
    }
    return {
      ...pairingResult(result.stdout),
      userData: { provider: PROVIDER, vmId, poolId }
    }
  } catch (error) {
    // A conflicting slug is owned by the earlier create. Leave it available for recovery.
    if (vmId || error.status !== 409) {
      await deleteThread(api, vmId || slug, slug, AbortSignal.timeout(4000)).catch(() =>
        console.error(`Cleanup could not be confirmed. Inspect VM ${vmId || slug} in Freestyle.`)
      )
    }
    throw error
  }
}

export async function runThreadLifecycle(api, mode, signal) {
  const payload = JSON.parse(await text(process.stdin))
  const result = payload.recipeResult
  const slug = threadSlug(payload.instanceId)
  const id = requireId(result?.userData?.vmId, 'vm', 'thread VM ID')
  if (
    payload.schemaVersion !== 1 ||
    payload.mode !== mode ||
    result?.userData?.provider !== PROVIDER
  ) {
    throw new Error('Expected a Freestyle thread lifecycle payload from Orca.')
  }
  if (mode === 'destroy') {
    await deleteThread(api, id, slug, signal)
    return { ok: true }
  }
  const vm = await ownedVm(api, id, slug, signal)
  if (mode === 'suspend') {
    if (vm.state === 'running') {
      await api('POST', `${vmPath(id)}/pause`, { signal, body: {}, timeoutMs: 120_000 })
    } else if (!['paused', 'pausing'].includes(vm.state)) {
      throw new Error(`Thread VM ${id} is ${vm.state} and cannot be suspended.`)
    }
    await waitForVm(api, id, 'paused', signal)
    return { ok: true }
  }
  if (vm.state === 'paused') {
    await api('POST', `${vmPath(id)}/start`, { signal, body: {}, timeoutMs: 120_000 })
  } else if (!['running', 'starting'].includes(vm.state)) {
    throw new Error(`Thread VM ${id} is ${vm.state}. Its Orca server needs a running checkpoint.`)
  }
  await waitForVm(api, id, 'running', signal)
  return result
}
