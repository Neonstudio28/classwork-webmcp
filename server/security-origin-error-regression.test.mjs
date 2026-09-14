import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('cross-origin rejection keeps JSON error semantics', async () => {
  const response = await fetch(`${server.baseUrl}/api/missing-origin-regression`, { headers: { origin: 'https://evil.example' } })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).code, 'CROSS_ORIGIN_REQUEST')
})
