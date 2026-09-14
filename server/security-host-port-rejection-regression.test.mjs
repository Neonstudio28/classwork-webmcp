import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('unconfigured host remains rejected when it supplies a port', async () => {
  const response = await fetch(`${server.baseUrl}/api/health`, { headers: { host: 'attacker.example:443' } })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).code, 'LOCAL_API_ONLY')
})
