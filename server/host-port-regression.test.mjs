import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('configured host with explicit port remains accepted', async () => {
  const response = await fetch(`${server.baseUrl}/api/health`, { headers: { host: 'classwork.example:443', origin: 'https://classwork.example' } })
  assert.equal(response.status, 200)
})
