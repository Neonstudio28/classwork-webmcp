import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('origin port does not silently match a different deployment port', async () => {
  const response = await fetch(`${server.baseUrl}/api/health`, { headers: { host: 'classwork.example', origin: 'https://classwork.example:8443' } })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).code, 'CROSS_ORIGIN_REQUEST')
})
