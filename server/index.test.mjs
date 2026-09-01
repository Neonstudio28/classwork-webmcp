import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { after, before, test } from 'node:test'

let child
let baseUrl
let testDataDirectory

function requestWithHost(path, { method = 'GET', host, origin, contentType, body = '' }) {
  const target = new URL(path)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers: {
        host,
        origin,
        ...(contentType ? { 'content-type': contentType } : {}),
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        })
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

before(async () => {
  testDataDirectory = await mkdtemp(join(tmpdir(), 'classwork-server-test-'))
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLASSWORK_AI_ENABLED: 'false',
      CLASSWORK_ALLOWED_HOSTS: 'classwork.example',
      CLASSWORK_DATA_DIR: testDataDirectory,
      CLASSWORK_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for the test server.')), 8_000)
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
      const match = output.match(/Classwork server ready at (http:\/\/127\.0\.0\.1:\d+)/)
      if (!match) return
      clearTimeout(timeout)
      resolve(match[1])
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Test server exited early with code ${code}.`))
    })
  })
})

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
  if (testDataDirectory) await rm(testDataDirectory, { recursive: true, force: true })
})

test('health endpoint is local and returns security headers', async () => {
  const response = await fetch(`${baseUrl}/api/health`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.equal((await response.json()).ok, true)
})

test('hostile browser origins are rejected before body handling', async () => {
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: {
      origin: 'https://evil.example',
      'content-type': 'text/plain',
    },
    body: '{}',
  })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).code, 'CROSS_ORIGIN_REQUEST')
})

test('configured deployment host accepts its matching browser origin', async () => {
  const response = await requestWithHost(`${baseUrl}/api/health`, {
    host: 'classwork.example',
    origin: 'https://classwork.example',
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
})

test('configured deployment host rejects a different browser origin', async () => {
  const response = await requestWithHost(`${baseUrl}/api/generate`, {
    method: 'POST',
    host: 'classwork.example',
    origin: 'https://evil.example',
    contentType: 'application/json',
    body: '{}',
  })
  assert.equal(response.status, 403)
  assert.equal(response.payload.code, 'CROSS_ORIGIN_REQUEST')
})

test('API mutations require JSON', async () => {
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      'content-type': 'text/plain',
    },
    body: '{}',
  })
  assert.equal(response.status, 415)
  assert.equal((await response.json()).code, 'JSON_REQUIRED')
})

test('malformed JSON is a generic client error', async () => {
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      'content-type': 'application/json',
    },
    body: '{broken',
  })
  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.equal(payload.code, 'INVALID_JSON')
  assert.equal(payload.error, 'Request body must contain valid JSON.')
})

test('unknown API routes return JSON 404 instead of the SPA', async () => {
  const response = await fetch(`${baseUrl}/api/does-not-exist`)
  assert.equal(response.status, 404)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/)
  assert.equal((await response.json()).code, 'API_NOT_FOUND')
})
