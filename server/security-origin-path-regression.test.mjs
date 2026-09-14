import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('same-origin validation applies consistently to nested API paths', async () => {
  const response = await fetch(`${server.baseUrl}/api/workspaces/invalid`, { headers: { origin: 'https://evil.example' } })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).code, 'CROSS_ORIGIN_REQUEST')
})
