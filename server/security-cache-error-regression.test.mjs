import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('API errors are not cached', async () => {
  const response = await fetch(`${server.baseUrl}/api/missing-cache-regression`)
  assert.equal(response.headers.get('cache-control'), 'no-store')
})
