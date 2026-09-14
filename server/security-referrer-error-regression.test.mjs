import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('API errors retain referrer policy', async () => {
  const response = await fetch(`${server.baseUrl}/api/missing-referrer-regression`)
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin')
})
