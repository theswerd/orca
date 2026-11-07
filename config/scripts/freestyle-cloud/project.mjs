import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, openAsBlob, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteIfPresent, execGuest, vmPath, waitForVm } from './api.mjs'

export const PROJECT_ROOT = '/var/tmp/orca-project'
export const PUBLIC_EGRESS = {
  rules: [{ action: 'allow', source: {}, destination: { public: true } }]
}

const BUNDLE_PATH = '/var/tmp/orca-project.bundle'
const GITHUB_HOST_KEY =
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
const SSH_COMMAND =
  'ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes ' +
  '-o ConnectTimeout=8 -o Hostname=ssh.github.com -o HostKeyAlias=github.com -p 443 ' +
  '-o UserKnownHostsFile="$HOME/.orca-cloud/known_hosts" -i "$HOME/.orca-cloud/repo-key"'

function localGit(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    windowsHide: true
  }).trim()
}

export function projectUrl(config) {
  let source
  try {
    source = config.ORCA_REPO_URL || localGit(['remote', 'get-url', 'origin'])
  } catch {
    throw new Error('Orca Cloud needs a Git project with an origin remote.')
  }
  const scp = /^git@([\w.-]+):([^\s]+)$/.exec(source)
  const url = URL.parse(scp ? `https://${scp[1]}/${scp[2]}` : source)
  if (url?.protocol === 'ssh:' && url.username === 'git' && !url.password && !url.port) {
    return projectUrl({ ORCA_REPO_URL: `https://${url.host}${url.pathname}` })
  }
  if (
    url?.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === '/'
  ) {
    throw new Error('Orca Cloud needs a Git origin without embedded credentials.')
  }
  if (url.host === 'github.com' && /^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname)) {
    const repository = url.pathname
      .toLowerCase()
      .replace(/\/$/, '')
      .replace(/\.git$/, '')
    url.pathname = `${repository}.git`
  }
  return url.href
}

function snapshotSlug(poolId, baseId, url) {
  const hash = createHash('sha256')
    .update(JSON.stringify([2, poolId, baseId, url]))
    .digest('hex')
  return `orca-project-${hash.slice(0, 32)}`
}

export async function findProjectSnapshot(api, poolId, baseId, url, signal) {
  const slug = snapshotSlug(poolId, baseId, url)
  try {
    return await api('GET', `snapshots/${slug}`, { signal })
  } catch (error) {
    if (error.status !== 404) {
      throw error
    }
  }
}

export const startDisplay = [
  'export DISPLAY=:97',
  'if ! [ -S /tmp/.X11-unix/X97 ]; then',
  '  setsid -f Xvfb "$DISPLAY" -nolisten tcp -screen 0 1280x800x24 </dev/null >/var/tmp/orca-xvfb.log 2>&1',
  '  for attempt in $(seq 1 50); do [ -S /tmp/.X11-unix/X97 ] && break; sleep 0.2; done',
  '  [ -S /tmp/.X11-unix/X97 ] || { cat /var/tmp/orca-xvfb.log >&2; exit 1; }',
  'fi'
].join('\n')

// Populate Orca’s runtime cache without starting a server or generating pairing state.
const prepareOrcad = [
  'orca_resources=$(dirname "$(dirname "$(readlink -f "$(command -v orca-ide)")")")',
  'orca_app="$orca_resources/app.asar"',
  'orca_entry=out/main/orcad/orcad-local-serve-selection-entry.js',
  'if [ -f "$orca_resources/app.asar.unpacked/$orca_entry" ]; then',
  '  ELECTRON_RUN_AS_NODE=1 "$orca_resources/../orca-ide" "$orca_app/$orca_entry" --user-data "${XDG_CONFIG_HOME:-$HOME/.config}/orca" --app-root "$orca_app" >&2',
  'fi'
].join('\n')

export async function prepareProject(api, poolId, baseId, url, signal) {
  const existing = await findProjectSnapshot(api, poolId, baseId, url, signal)
  if (existing) {
    return { poolId, snapshotId: existing.id }
  }

  const slug = snapshotSlug(poolId, baseId, url)
  let branchRef
  try {
    branchRef = localGit(['symbolic-ref', 'refs/remotes/origin/HEAD'])
  } catch {
    throw new Error(
      'Run git remote set-head origin --auto in the project before preparing its snapshot.'
    )
  }
  const branch = branchRef.replace(/^refs\/remotes\/origin\//, '')
  const scratch = mkdtempSync(join(tmpdir(), 'orca-cloud-project-'))
  let builderId
  try {
    const bundle = join(scratch, 'project.bundle')
    // Seed only published tracking refs so unpublished local branches stay on the desktop.
    localGit(['bundle', 'create', bundle, '--remotes=origin'])
    console.error('Preparing the project snapshot from your origin tracking refs.')
    const builder = await api('POST', 'vms', {
      signal,
      timeoutMs: 120_000,
      body: {
        poolId,
        snapshotId: baseId,
        displayName: 'Orca Cloud project snapshot builder',
        poolLimits: { memoryFloor: 16 },
        firewall: PUBLIC_EGRESS
      }
    })
    builderId = builder.id
    if (builder.state !== 'running') {
      await waitForVm(api, builderId, 'running', signal)
    }
    await api('PUT', `${vmPath(builderId)}/fs/write?path=${encodeURIComponent(BUNDLE_PATH)}`, {
      bytes: await openAsBlob(bundle),
      signal,
      timeoutMs: 180_000
    })
    const result = await execGuest(api, builderId, signal, {
      env: {
        ORCA_PROJECT_ROOT: PROJECT_ROOT,
        ORCA_PROJECT_URL: url,
        ORCA_DEFAULT_BRANCH: branch,
        ORCA_SOURCE_BUNDLE: BUNDLE_PATH
      },
      command: [
        'set -eu',
        'git init -q "$ORCA_PROJECT_ROOT"',
        'cd "$ORCA_PROJECT_ROOT"',
        'git remote add origin "$ORCA_PROJECT_URL"',
        'git fetch -q "$ORCA_SOURCE_BUNDLE" "+refs/remotes/origin/*:refs/remotes/origin/*"',
        'git symbolic-ref refs/remotes/origin/HEAD "refs/remotes/origin/$ORCA_DEFAULT_BRANCH"',
        'git checkout -q --detach refs/remotes/origin/HEAD',
        'rm -f "$ORCA_SOURCE_BUNDLE"',
        prepareOrcad,
        startDisplay
      ].join('\n')
    })
    if (result.statusCode !== 0) {
      throw new Error(
        `Could not prepare the project snapshot: ${result.stderr?.trim().slice(-1200)}`
      )
    }
    const snapshot = await api('POST', `${vmPath(builderId)}/snapshot`, {
      signal,
      timeoutMs: 120_000,
      body: { slug, displayName: `Orca Cloud: ${new URL(url).pathname}` }
    })
    return { poolId, snapshotId: snapshot.snapshotId }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    if (builderId) {
      await deleteIfPresent(api, vmPath(builderId), { timeoutMs: 120_000 }).catch(() =>
        console.error(`Cleanup could not be confirmed for project snapshot builder ${builderId}.`)
      )
    }
  }
}

export function projectAuthentication(url) {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\.git$/.exec(url)
  if (!match) {
    return { env: {}, install: ':', configure: ':' }
  }

  const keyPath = join(
    homedir(),
    '.orca',
    'freestyle-cloud',
    'keys',
    `github.com--${match[1]}--${match[2]}`
  )
  let key
  try {
    if (process.platform !== 'win32' && (statSync(keyPath).mode & 0o077) !== 0) {
      throw new Error('The Orca Cloud deploy key must have file mode 0600.')
    }
    key = readFileSync(keyPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { env: {}, install: ':', configure: ':' }
    }
    throw error
  }

  return {
    env: {
      ORCA_DEPLOY_KEY: key,
      ORCA_GITHUB_HOST_KEY: GITHUB_HOST_KEY,
      ORCA_GIT_SSH_COMMAND: SSH_COMMAND,
      ORCA_PROJECT_SSH_URL: `ssh://git@github.com/${match[1]}/${match[2]}.git`
    },
    install: [
      'umask 077',
      'mkdir -p "$HOME/.orca-cloud"',
      'printf "%s" "$ORCA_DEPLOY_KEY" > "$HOME/.orca-cloud/repo-key"',
      'unset ORCA_DEPLOY_KEY',
      'chmod 600 "$HOME/.orca-cloud/repo-key"',
      'printf "%s\\n" "$ORCA_GITHUB_HOST_KEY" > "$HOME/.orca-cloud/known_hosts"',
      'umask "$orca_umask"'
    ].join('\n'),
    configure: [
      'git -C "$ORCA_PROJECT_ROOT" config core.sshCommand "$ORCA_GIT_SSH_COMMAND"',
      'git -C "$ORCA_PROJECT_ROOT" config "url.$ORCA_PROJECT_SSH_URL.insteadOf" "$ORCA_PROJECT_URL"'
    ].join('\n')
  }
}
