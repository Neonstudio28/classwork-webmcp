import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('same-host origin matching survives mixed-case schemes and host', async () => {
  const response = await fetch(`${server.baseUrl}/api/health`, { headers: { host: 'classwork.example', origin: 'HTTPS://CLASSWORK.EXAMPLE' } })
  assert.equal(response.status, 200)
})
