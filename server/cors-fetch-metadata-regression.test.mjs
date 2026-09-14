import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('cross-site fetch metadata is rejected', async () => {
  const response = await fetch(`${server.baseUrl}/api/health`, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).code, 'CROSS_ORIGIN_REQUEST')
})
