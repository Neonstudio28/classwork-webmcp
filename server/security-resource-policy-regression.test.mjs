import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('API errors retain same-origin resource policy', async () => {
  const response = await fetch(`${server.baseUrl}/api/missing-resource-policy`)
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
})
