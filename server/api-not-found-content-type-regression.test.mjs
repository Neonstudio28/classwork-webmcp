import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('missing API route always advertises JSON', async () => {
  const response = await fetch(`${server.baseUrl}/api/missing-regression-route`)
  assert.equal(response.status, 404)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/)
})
