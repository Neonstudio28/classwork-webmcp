import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('API method validation happens before unknown-route handling', async () => {
  const response = await fetch(`${server.baseUrl}/api/missing-method-regression`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
  assert.equal(response.status, 415)
  assert.equal((await response.json()).code, 'JSON_REQUIRED')
})
