import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseEnv } from 'node:util'

export function readConfig() {
  const path = join(homedir(), '.orca', 'freestyle-cloud.env')
  let file = {}
  try {
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
      throw new Error(`Run chmod 600 "${path}" before using this file.`)
    }
    file = parseEnv(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }
  return { ...file, ...process.env }
}

export class FreestyleError extends Error {
  constructor(method, path, status, code) {
    super(`Freestyle ${method} ${path} returned HTTP ${status}${code ? ` (${code})` : ''}.`)
    this.status = status
  }
}

export function createApi(config) {
  if (!config.FREESTYLE_API_KEY) {
    throw new Error('Set FREESTYLE_API_KEY for the Freestyle canary account.')
  }
  const origin = new URL(config.FREESTYLE_API_URL || 'https://api.freestyle.sh')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) {
    throw new Error('FREESTYLE_API_URL must use HTTPS or point to a local HTTP test server.')
  }

  return async function request(
    method,
    path,
    { body, bytes, headers, signal, timeoutMs = 30_000, background = false } = {}
  ) {
    const timeout = AbortSignal.timeout(timeoutMs)
    const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout
    const payload = bytes ?? (body === undefined ? undefined : JSON.stringify(body))
    const response = await fetch(new URL(`/v5/${path}`, origin), {
      method,
      headers: {
        Authorization: `Bearer ${config.FREESTYLE_API_KEY}`,
        ...(bytes ? { 'Content-Type': 'application/octet-stream' } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(background ? { 'X-Freestyle-Background-After-Secs': '1' } : {}),
        ...headers
      },
      ...(payload === undefined ? {} : { body: payload }),
      redirect: 'error',
      signal: requestSignal
    })
    if (response.status === 204) {
      return
    }
    const data = await response.json().catch(() => undefined)
    if (response.status === 202 && background) {
      const requestId = data?.requestId ?? response.headers.get('x-freestyle-background-request-id')
      if (!requestId) {
        throw new Error('Freestyle accepted the guest command without a request ID.')
      }
      return await pollBackgroundRequest(request, requestId, requestSignal)
    }
    if (!response.ok) {
      const code = data?.code ?? data?.error?.code
      throw new FreestyleError(method, path, response.status, /^[A-Z_]+$/.test(code) ? code : '')
    }
    if (data === undefined) {
      throw new Error(`Freestyle ${method} ${path} returned invalid JSON.`)
    }
    return data
  }
}

async function pollBackgroundRequest(request, requestId, signal) {
  do {
    await delay(250, undefined, { signal })
    const result = await request('GET', `background-requests/${encodeURIComponent(requestId)}`, {
      signal
    })
    if (result?.status !== 'pending') {
      return result
    }
  } while (!signal.aborted)
  signal.throwIfAborted()
}

export function vmPath(id) {
  return `vms/${encodeURIComponent(id)}`
}

export async function waitForVm(api, id, target, signal) {
  const deadline = AbortSignal.timeout(120_000)
  const waiting = signal ? AbortSignal.any([signal, deadline]) : deadline
  while (!waiting.aborted) {
    const vm = await api('GET', vmPath(id), { signal: waiting })
    if (vm.state === target) {
      return vm
    }
    if (target === 'running' && vm.state === 'stopped') {
      throw new Error(`VM ${id} stopped before it became ready.`)
    }
    await delay(1000, undefined, { signal: waiting })
  }
  waiting.throwIfAborted()
}

export async function deleteIfPresent(api, path, options) {
  try {
    await api('DELETE', path, options)
  } catch (error) {
    if (error.status !== 404) {
      throw error
    }
  }
}

export function execGuest(api, vmId, signal, { command, env }) {
  return api('POST', `${vmPath(vmId)}/exec-await`, {
    signal,
    timeoutMs: 210_000,
    background: true,
    body: { timeoutMs: 180_000, command, env }
  })
}
