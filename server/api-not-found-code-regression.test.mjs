import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startRegressionServer } from './regression-test-helpers.mjs'
let server
before(async () => { server = await startRegressionServer() })
after(async () => server.close())
test('missing API route keeps stable machine-readable code', async () => {
  const response = await fetch(`${server.baseUrl}/api/missing-code-regression`)
  assert.equal((await response.json()).code, 'API_NOT_FOUND')
})
