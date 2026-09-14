import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('health endpoint does not require an application body', async () => {
  const response = await fetch(`${server.baseUrl}/api/health`, { headers: { 'content-type': 'application/json' } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)
})
