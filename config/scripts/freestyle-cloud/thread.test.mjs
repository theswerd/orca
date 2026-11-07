import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { text } from 'node:stream/consumers'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url))

test('each Orca thread gets an isolated pool member that survives sleep and wake', async (t) => {
  const vms = new Map()
  let nextVm = 0
  const server = createServer(async (request, response) => {
    try {
      const body = await text(request)
      const result = handle(request.method, request.url, request.headers, body && JSON.parse(body))
      response.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result.body))
    } catch (error) {
      response.writeHead(500)
      response.end()
      t.diagnostic(error.message)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())

  function handle(method, url, headers, body) {
    if (method === 'POST' && url === '/v5/pools') {
      assert.equal(headers['x-freestyle-target-manager'], 'canary')
      assert.deepEqual(body, { cpu: 4, memory: 4096, storage: 16384 })
      return { status: 201, body: { id: 'pool-demo' } }
    }
    if (method === 'POST' && url === '/v5/vms') {
      assert.equal(body.poolId, 'pool-demo')
      if (body.virtiofs) {
        assert.deepEqual(body.virtiofs, { base: 'staged-base', prepare: true, dax: true })
        assert.equal(body.bsvmm, 'nightly')
        assert.deepEqual(body.source.resources, { cpu: 2, memory: 2048, storage: 4096 })
      } else {
        assert.equal(body.snapshotId, 'sh-prepared')
        assert.equal(body.tls.rules[0].domain, `${body.slug}.style.dev`)
      }
      assert.ok([...vms.values()].every((vm) => vm.slug !== body.slug))
      const vm = {
        id: `vm-${++nextVm}`,
        slug: body.slug,
        state: 'running',
        metadata: body.metadata,
        prepared: Boolean(body.virtiofs)
      }
      vms.set(vm.id, vm)
      return { status: 201, body: vm }
    }
    if (url === '/v5/background-requests/test-exec') {
      return {
        body: {
          statusCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 1,
            pairingCode: 'orca://pair?code=mock',
            projectRoot: '/var/tmp/orca-project'
          })
        }
      }
    }
    const [, id, action] = /^\/v5\/vms\/([^/]+)(?:\/(.+))?$/.exec(url) ?? []
    const vm = vms.get(id)
    if (!vm) {
      return { status: 404, body: {} }
    }
    if (action === 'exec-await') {
      assert.equal(headers['x-freestyle-background-after-secs'], '1')
      assert.equal(body.env.ORCA_PROJECT_URL, 'https://github.com/example/project.git')
      assert.equal(body.env.ORCA_PAIRING_ADDRESS, `wss://${vm.slug}.style.dev`)
      if (id === 'vm-3') {
        return { body: { statusCode: 1 } }
      }
      return { status: 202, body: { requestId: 'test-exec', status: 'pending' } }
    }
    if (action === 'snapshot') {
      assert.equal(vm.prepared, true)
      vm.captured = true
      return { body: { snapshotId: 'sh-new-template' } }
    }
    if (action === 'stop') {
      assert.equal(vm.captured, true)
      vm.state = 'stopped'
    }
    if (action === 'pause') {
      vm.state = 'paused'
    }
    if (action === 'start') {
      vm.state = 'running'
    }
    if (method === 'DELETE') {
      vms.delete(id)
      return { status: 204 }
    }
    return { body: vm }
  }

  async function run(mode, instanceId, recipeResult, args = []) {
    const child = spawn(process.execPath, [cliPath, mode, ...args], {
      env: {
        ...process.env,
        FREESTYLE_API_URL: `http://127.0.0.1:${server.address().port}`,
        FREESTYLE_API_KEY: 'fake',
        FREESTYLE_ORCA_POOL_ID: 'pool-demo',
        FREESTYLE_ORCA_SNAPSHOT_ID: 'sh-prepared',
        FREESTYLE_ORCA_DOMAIN_SUFFIX: 'style.dev',
        ORCA_REPO_URL: 'git@github.com:example/project.git',
        ORCA_VM_INSTANCE_ID: instanceId
      },
      stdio: 'pipe'
    })
    const result = Promise.all([once(child, 'exit'), text(child.stdout), text(child.stderr)])
    child.stdin.end(JSON.stringify({ schemaVersion: 1, mode, instanceId, recipeResult }))
    const [[code], stdout, stderr] = await result
    return { code, result: stdout && JSON.parse(stdout), stderr }
  }

  const pool = await run('pool-create', '', undefined, ['canary', '4', '4096', '16384'])
  assert.deepEqual(pool.result, { id: 'pool-demo' })
  const first = await run('create', 'thread-a')
  const second = await run('create', 'thread-b')
  assert.equal(first.result.userData.vmId, 'vm-1')
  assert.equal(second.result.userData.vmId, 'vm-2')
  assert.doesNotMatch(first.stderr, /orca:\/\/pair/)
  assert.equal((await run('suspend', 'thread-a', first.result)).code, 0)
  assert.equal(vms.get('vm-1').state, 'paused')
  assert.equal(vms.get('vm-2').state, 'running')
  assert.deepEqual((await run('resume', 'thread-a', first.result)).result, first.result)
  assert.equal(vms.get('vm-1').state, 'running')
  assert.equal((await run('destroy', 'thread-b', first.result)).code, 1)
  assert.equal((await run('create', 'failed-thread')).code, 1)
  assert.deepEqual([...vms.keys()], ['vm-1', 'vm-2'])
  assert.equal((await run('destroy', 'thread-a', first.result)).code, 0)
  assert.equal((await run('destroy', 'thread-a', first.result)).code, 0)
  assert.deepEqual([...vms.keys()], ['vm-2'])

  const template = await run('template-create', '', undefined, ['staged-base', '2', '2048', '4096'])
  assert.deepEqual(template.result, {
    poolId: 'pool-demo',
    snapshotId: 'sh-new-template',
    bootstrapVmId: 'vm-4'
  })
  assert.equal(vms.get('vm-4').state, 'stopped')
})
