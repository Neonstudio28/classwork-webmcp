import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('API errors retain nosniff protection', async () => {
  const response = await fetch(`${server.baseUrl}/api/missing-security-regression`)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
})
