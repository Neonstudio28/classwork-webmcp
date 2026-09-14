import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('https origin with unconfigured host is rejected', async () => {
  const response = await fetch(`${server.baseUrl}/api/health`, { headers: { host: 'attacker.example', origin: 'https://attacker.example' } })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).code, 'LOCAL_API_ONLY')
})
