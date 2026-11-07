import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, openAsBlob, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { deleteIfPresent, vmPath, waitForVm } from './api.mjs'

const ORCA_PORT = 7331
const PROJECT_ROOT = '/var/tmp/orca-project'
const GUEST_BUNDLE_PATH = '/var/tmp/orca-source.bundle'
const PROVIDER = 'freestyle-resource-pool'

function threadSlug(instanceId) {
  if (!instanceId) {
    throw new Error('The Orca recipe must supply ORCA_VM_INSTANCE_ID.')
  }
  const hash = createHash('sha256').update(instanceId).digest('hex').slice(0, 32)
  return `orca-thread-${hash}`
}

function repositoryUrl(config) {
  const source =
    config.ORCA_REPO_URL ||
    spawnSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      windowsHide: true
    }).stdout?.trim() ||
    ''
  const ssh = /^git@([\w.-]+):([^\s]+)$/.exec(source)
  const url = URL.parse(ssh ? `https://${ssh[1]}/${ssh[2]}` : source)
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === '/'
  ) {
    throw new Error('The project needs an HTTPS origin without embedded Git credentials.')
  }
  return url.href
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
  const snapshotId = requireId(
    config.FREESTYLE_ORCA_SNAPSHOT_ID,
    'sh',
    'FREESTYLE_ORCA_SNAPSHOT_ID'
  )
  const repoUrl = repositoryUrl(config)
  const suffix = config.FREESTYLE_ORCA_DOMAIN_SUFFIX || 'style.dev'
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(suffix)) {
    throw new Error('Set FREESTYLE_ORCA_DOMAIN_SUFFIX to a DNS suffix without a wildcard.')
  }
  const domain = `${slug}.${suffix}`

  let vmId
  console.error(`Creating VM ${slug} in pool ${poolId}.`)
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
        firewall: { rules: [{ action: 'allow', source: {}, destination: { public: true } }] },
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
    await waitForVm(api, vmId, 'running', signal)
    await checkoutRepository(api, vmId, repoUrl, signal)
    console.error(`Starting Orca in ${vmId}.`)
    const result = await execGuest(api, vmId, signal, {
      env: {
        ORCA_PROJECT_ROOT: PROJECT_ROOT,
        ORCA_PAIRING_ADDRESS: `wss://${domain}`,
        ORCA_PORT: String(ORCA_PORT)
      },
      command: [
        'set -eu',
        'export DISPLAY=:97',
        'setsid -f Xvfb "$DISPLAY" -nolisten tcp -screen 0 1280x800x24 </dev/null >/var/tmp/orca-xvfb.log 2>&1',
        'for attempt in $(seq 1 50); do [ -S /tmp/.X11-unix/X97 ] && break; sleep 0.2; done',
        '[ -S /tmp/.X11-unix/X97 ] || { cat /var/tmp/orca-xvfb.log >&2; exit 1; }',
        'orca-ide serve --port "$ORCA_PORT" --project-root "$ORCA_PROJECT_ROOT" --pairing-address "$ORCA_PAIRING_ADDRESS" --recipe-json 2>"$HOME/.orca-cloud-serve.log" || { tail -20 "$HOME/.orca-cloud-serve.log" >&2; exit 1; }'
      ].join('\n')
    })
    if (result.statusCode !== 0) {
      const reason = result.stderr
        ?.trim()
        .replace(/orca:\/\/\S+/g, '[pairing link]')
        .slice(-1800)
      throw new Error(
        `Orca server could not start in the guest (exit ${result.statusCode}).${reason ? ` ${reason}` : ''}`
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

async function execGuest(api, vmId, signal, { command, env }) {
  return api('POST', `${vmPath(vmId)}/exec-await`, {
    signal,
    timeoutMs: 210_000,
    background: true,
    body: { timeoutMs: 180_000, command, env }
  })
}

async function checkoutRepository(api, vmId, repoUrl, signal) {
  const env = {
    GIT_TERMINAL_PROMPT: '0',
    ORCA_PROJECT_URL: repoUrl,
    ORCA_PROJECT_ROOT: PROJECT_ROOT,
    ORCA_SOURCE_BUNDLE: GUEST_BUNDLE_PATH
  }
  const clone = await execGuest(api, vmId, signal, {
    env,
    command: 'git clone --filter=blob:none -- "$ORCA_PROJECT_URL" "$ORCA_PROJECT_ROOT"'
  })
  if (clone.statusCode === 0) {
    return
  }
  if (clone.statusCode !== 128) {
    throw new Error('Git could not clone the repository in the guest.')
  }

  console.error('The guest could not clone from the Git remote. Sending the local Git checkout.')
  const scratch = mkdtempSync(join(tmpdir(), 'orca-cloud-git-'))
  try {
    const path = join(scratch, 'source.bundle')
    const bundle = spawnSync(
      'git',
      ['bundle', 'create', path, 'HEAD', '--branches', '--tags', '--remotes=origin'],
      { encoding: 'utf8', timeout: 120_000, windowsHide: true }
    )
    if (bundle.status !== 0) {
      throw new Error('Could not bundle the local Git checkout.')
    }
    await api('PUT', `${vmPath(vmId)}/fs/write?path=${encodeURIComponent(GUEST_BUNDLE_PATH)}`, {
      bytes: await openAsBlob(path),
      signal,
      timeoutMs: 180_000
    })
    const uploaded = await execGuest(api, vmId, signal, {
      env,
      command: [
        'git clone -- "$ORCA_SOURCE_BUNDLE" "$ORCA_PROJECT_ROOT"',
        'git -C "$ORCA_PROJECT_ROOT" fetch "$ORCA_SOURCE_BUNDLE" "+refs/remotes/origin/*:refs/remotes/origin/*"',
        'git -C "$ORCA_PROJECT_ROOT" remote set-url origin "$ORCA_PROJECT_URL"',
        'rm -f "$ORCA_SOURCE_BUNDLE"'
      ].join(' && ')
    })
    if (uploaded.statusCode !== 0) {
      throw new Error('The guest could not restore the local Git checkout.')
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
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
