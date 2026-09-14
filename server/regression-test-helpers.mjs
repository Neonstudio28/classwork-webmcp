import { mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function startRegressionServer() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'classwork-regression-'))
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLASSWORK_AI_ENABLED: 'false',
      CLASSWORK_ALLOWED_HOSTS: 'classwork.example',
      CLASSWORK_DATA_DIR: dataDirectory,
      CLASSWORK_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for regression server.')), 8_000)
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
      reject(new Error(`Regression server exited early with code ${code}.`))
    })
  })

  return {
    baseUrl,
    async close() {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.once('exit', resolve))
      }
      await rm(dataDirectory, { recursive: true, force: true })
    },
  }
}
