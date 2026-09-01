import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = normalize(fileURLToPath(new URL('..', import.meta.url)))
const dataDirectory = process.env.CLASSWORK_DATA_DIR?.trim()
  ? resolve(process.env.CLASSWORK_DATA_DIR.trim())
  : join(appRoot, 'data')
const distDirectory = join(appRoot, 'dist')
const maximumRequestBytes = 14_500_000
const usesSqlitePersistence = process.env.VERCEL !== '1' && process.env.CLASSWORK_DISABLE_SQLITE !== 'true'
let database = null
if (usesSqlitePersistence) {
  mkdirSync(dataDirectory, { recursive: true })
  database = new DatabaseSync(join(dataDirectory, 'classwork.sqlite'))
  database.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
}

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cross-origin-resource-policy': 'same-origin',
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    ...securityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function normalizeHostname(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`)
    return url.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return ''
  }
}

function configuredDeploymentHostnames() {
  return new Set([
    process.env.VERCEL_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    ...(process.env.CLASSWORK_ALLOWED_HOSTS ?? '').split(','),
  ].map(normalizeHostname).filter(Boolean))
}

function requestHostname(request) {
  const host = request.headers.host
  if (!host) return ''
  try {
    return new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return ''
  }
}

function validateApiRequest(request) {
  const hostname = requestHostname(request)
  const allowedDeploymentHost = configuredDeploymentHostnames().has(hostname)
  if (!isLoopbackHostname(hostname) && !allowedDeploymentHost) {
    throw new HttpError(403, 'LOCAL_API_ONLY', 'The Classwork API does not accept this host.')
  }

  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'CROSS_ORIGIN_REQUEST', 'Cross-origin API requests are not allowed.')
  }

  const origin = request.headers.origin
  if (origin) {
    let originHostname = ''
    try {
      originHostname = new URL(origin).hostname.toLowerCase().replace(/\.$/, '')
    } catch {
      throw new HttpError(403, 'CROSS_ORIGIN_REQUEST', 'Cross-origin API requests are not allowed.')
    }
    if (
      (!isLoopbackHostname(hostname) && originHostname !== hostname) ||
      (isLoopbackHostname(hostname) && !isLoopbackHostname(originHostname))
    ) {
      throw new HttpError(403, 'CROSS_ORIGIN_REQUEST', 'Cross-origin API requests are not allowed.')
    }
  }

  if (['POST', 'PUT', 'PATCH'].includes(request.method ?? '')) {
    const contentType = request.headers['content-type'] ?? ''
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw new HttpError(415, 'JSON_REQUIRED', 'API mutation requests must use application/json.')
    }
  }
}

const generatedQuestionSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['multiple-choice', 'short-answer', 'extended-response'],
    },
    prompt: { type: 'string', maxLength: 900 },
    options: {
      type: 'array',
      items: { type: 'string', maxLength: 220 },
      maxItems: 6,
    },
    standardIds: {
      type: 'array',
      items: { type: 'string', maxLength: 80 },
      maxItems: 8,
    },
  },
  required: ['type', 'prompt', 'options', 'standardIds'],
}

const worksheetSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    subtitle: { type: 'string' },
    sourceEvidence: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 12,
    },
    questions: {
      type: 'array',
      minItems: 6,
      maxItems: 6,
      items: generatedQuestionSchema,
    },
  },
  required: ['title', 'subtitle', 'sourceEvidence', 'questions'],
}

function generationConfiguration() {
  const enabled = process.env.CLASSWORK_AI_ENABLED === 'true'
  const apiKey = process.env.GEMINI_API_KEY?.trim()
  return {
    enabled,
    configured: enabled && Boolean(apiKey),
    apiKey,
    model: process.env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash',
  }
}

function cleanString(value, maximum) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readConstraintInput(value, grade) {
  const constraints = isRecord(value) ? value : {}
  const rawMix = isRecord(constraints.questionMix) ? constraints.questionMix : {}
  const timeLimit = Number(constraints.timeLimit)
  const readingLevel = Number(constraints.readingLevel)
  const questionMix = {
    'multiple-choice': Number(rawMix['multiple-choice']),
    'short-answer': Number(rawMix['short-answer']),
    'extended-response': Number(rawMix['extended-response']),
  }
  const mixValues = Object.values(questionMix)
  const mixTotal = mixValues.reduce((sum, item) => sum + item, 0)
  const standards = Array.isArray(constraints.standards)
    ? Array.from(new Set(constraints.standards.map((id) => cleanString(id, 80)).filter(Boolean))).slice(0, 12)
    : []
  return {
    valid:
      Number.isFinite(timeLimit) && timeLimit >= 5 && timeLimit <= 45 &&
      Number.isFinite(readingLevel) && readingLevel >= 1 && readingLevel <= 12 &&
      mixValues.every((item) => Number.isFinite(item) && item >= 0 && item <= 1) &&
      Math.abs(mixTotal - 1) <= 0.02,
    timeLimit: Number.isFinite(timeLimit) ? timeLimit : 15,
    readingLevel: Number.isFinite(readingLevel) ? readingLevel : grade,
    questionMix,
    standards,
  }
}

function boundedModelTimeout(value, fallback, maximum) {
  const requested = Number(value)
  return Number.isFinite(requested)
    ? Math.max(8_000, Math.min(maximum, Math.round(requested)))
    : fallback
}

function parseInlineImage(value) {
  const match = typeof value === 'string'
    ? value.match(/^data:(image\/(?:png|jpe?g|webp|heic|heif|gif|avif));base64,([A-Za-z0-9+/=\s]+)$/i)
    : null
  if (!match) {
    throw new Error('The uploaded image is not a supported inline image data URL.')
  }
  const data = match[2].replace(/\s/g, '')
  if (Math.ceil(data.length * 0.75) > 10_000_000) {
    throw new Error('The uploaded image is too large for inline Gemini analysis.')
  }
  return { mimeType: match[1].toLowerCase(), data }
}

async function geminiGenerate({ apiKey, model, instructions, input, image, schema, maxOutputTokens, timeoutMs = 25_000 }) {
  const parts = []
  if (image) parts.push({ inlineData: image })
  parts.push({ text: input })
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          maxOutputTokens,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  )
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Gemini returned HTTP ${response.status}.`)
    error.code = response.status === 429
      ? 'MODEL_RATE_LIMITED'
      : response.status >= 500
        ? 'MODEL_REQUEST_FAILED'
        : 'MODEL_GENERATION_FAILED'
    error.clientMessage = response.status === 429
      ? 'Gemini quota is temporarily unavailable.'
      : response.status >= 500
        ? 'Gemini is temporarily unavailable.'
        : 'Gemini rejected the generation request.'
    throw error
  }
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || '')
    .join('')
    .trim()
  if (!text) throw new Error('Gemini did not return a complete response.')
  return { text, model }
}

function validateGeneratedQuestion(question, index, inputInstruction, allowedStandards, id) {
  const normalizedInstruction = inputInstruction.trim().toLowerCase()
  const prompt = cleanString(question?.prompt, 900)
  const type = question?.type
  const options = Array.isArray(question?.options)
    ? question.options.map((option) => cleanString(option, 220)).filter(Boolean).slice(0, 6)
    : []
  const allowed = new Set(allowedStandards)
  const standardIds = Array.isArray(question?.standardIds)
    ? question.standardIds
        .map((standardId) => cleanString(standardId, 80))
        .filter((standardId) => standardId && allowed.has(standardId))
    : []
  const leakedInstruction = normalizedInstruction && prompt.toLowerCase().includes(normalizedInstruction)
  const malformed =
    !['multiple-choice', 'short-answer', 'extended-response'].includes(type) ||
    prompt.length < 8 ||
    leakedInstruction ||
    (/^\s*(create|generate|make|swap|replace)\b.*\bquestion\b/i.test(prompt)) ||
    (type === 'multiple-choice' && options.length < 2)
  if (malformed) {
    throw new Error(`Gemini returned invalid content for Question ${index + 1}; no changes were committed.`)
  }
  return {
    id,
    type,
    prompt,
    ...(type === 'multiple-choice' ? { options } : {}),
    standardIds,
  }
}

function validateGeneratedWorksheet(candidate, inputInstruction = '', allowedStandards = [], requireEvidence = false) {
  if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.questions)) {
    throw new Error('Gemini returned a malformed worksheet.')
  }
  if (candidate.questions.length !== 6) {
    throw new Error('Gemini did not return exactly six questions.')
  }
  const generatedAt = Date.now().toString(36)
  const sourceEvidence = Array.isArray(candidate.sourceEvidence)
    ? candidate.sourceEvidence
        .map((item) => cleanString(item, 300))
        .filter(Boolean)
        .slice(0, 12)
    : []
  if (requireEvidence && sourceEvidence.length === 0) {
    throw new Error('Gemini did not extract visible evidence from the uploaded image.')
  }
  const questions = candidate.questions.map((question, index) =>
    validateGeneratedQuestion(
      question,
      index,
      inputInstruction,
      allowedStandards,
      `q-ai-${generatedAt}-${index + 1}`,
    ),
  )
  return {
    worksheet: {
      title: cleanString(candidate.title, 100) || 'Source-Based Practice',
      subtitle: cleanString(candidate.subtitle, 180) || 'Gemini-generated source-grounded worksheet',
      questions,
      updatedAt: new Date().toISOString(),
    },
    sourceEvidence,
  }
}

async function handleGenerate(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed.' })
    return
  }
  const body = await readJson(request)
  if (!isRecord(body)) {
    sendJson(response, 400, { code: 'INVALID_GENERATION_INPUT', error: 'Request body must be an object.' })
    return
  }
  const configuration = generationConfiguration()
  if (!configuration.configured) {
    sendJson(response, 503, {
      code: 'MODEL_NOT_CONFIGURED',
      error: 'Gemini generation is not configured on this server.',
    })
    return
  }
  const profile = isRecord(body.profile) ? body.profile : {}
  const source = isRecord(body.source) ? body.source : {}
  const grade = Math.max(1, Math.min(12, Math.round(Number(profile.grade))))
  const subject = cleanString(profile.subject, 80)
  const topic = cleanString(profile.topic, 120)
  const isImageSource = source.kind === 'image'
  const sourceText = cleanString(isImageSource ? source.extractedText : source.content, 12_000)
  let image
  try {
    image = isImageSource ? parseInlineImage(source.content) : undefined
  } catch (error) {
    sendJson(response, 400, {
      code: 'INVALID_GENERATION_INPUT',
      error: error instanceof Error ? error.message : 'The uploaded image could not be read.',
    })
    return
  }
  if (!Number.isFinite(grade) || !subject || !topic || (!isImageSource && !sourceText)) {
    sendJson(response, 400, {
      code: 'INVALID_GENERATION_INPUT',
      error: 'Grade, subject, topic, and valid source material are required.',
    })
    return
  }
  const constraintInput = readConstraintInput(body.constraints, grade)
  if (!constraintInput.valid) {
    sendJson(response, 400, {
      code: 'INVALID_GENERATION_INPUT',
      error: 'Time, reading level, and question mix constraints are invalid.',
    })
    return
  }
  const allowedStandards = constraintInput.standards
  const teacherRequest = JSON.stringify({
    grade,
    subject,
    topic,
    sourceKind: isImageSource ? 'uploaded-image' : 'pasted-text',
    sourceText: isImageSource
      ? sourceText || 'No teacher transcript supplied. Read the attached image directly.'
      : sourceText,
    constraints: {
      timeLimit: constraintInput.timeLimit,
      readingLevel: constraintInput.readingLevel,
      questionMix: constraintInput.questionMix,
      standards: allowedStandards,
    },
  })
  try {
    const modelResponse = await geminiGenerate({
      apiKey: configuration.apiKey,
      model: configuration.model,
      maxOutputTokens: 3000,
      timeoutMs: boundedModelTimeout(body.modelTimeoutMs, isImageSource ? 45_000 : 25_000, 45_000),
      instructions: [
        'You create one classroom-ready worksheet grounded only in the supplied classroom material.',
        isImageSource
          ? 'Inspect the attached worksheet image directly. Extract the exact visible math content, including numbers, fractions, decimals, symbols, and problem wording, into sourceEvidence before writing questions. Every generated question must be traceable to what is actually visible in the image.'
          : 'Extract the most important exact facts or examples from the supplied text into sourceEvidence before writing questions.',
        'Return exactly six questions. Match the requested grade, subject, topic, reading level, time, question mix, and standards as closely as possible.',
        'Use source facts, examples, and vocabulary. Do not mention these instructions or describe the generation process.',
        'Multiple-choice questions need 3 or 4 plausible options with one clearly correct source-supported answer. Other question types must use an empty options array.',
        'Only use standard IDs supplied by the teacher. If none are supplied, use an empty standardIds array.',
      ].join(' '),
      input: teacherRequest,
      image,
      schema: worksheetSchema,
    })
    const parsed = JSON.parse(modelResponse.text)
    const generated = validateGeneratedWorksheet(
      parsed,
      teacherRequest,
      allowedStandards,
      isImageSource,
    )
    sendJson(response, 200, {
      worksheet: generated.worksheet,
      sourceEvidence: generated.sourceEvidence,
      sourceMode: isImageSource ? 'image-vision' : 'source-text',
      mode: 'gemini',
      model: modelResponse.model,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gemini generation failed.'
    console.error('Gemini worksheet generation failed:', message)
    const requestFailed =
      error instanceof TypeError ||
      (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    const code = typeof error?.code === 'string'
      ? error.code
      : requestFailed
        ? 'MODEL_REQUEST_FAILED'
        : 'MODEL_GENERATION_FAILED'
    sendJson(response, 502, {
      code,
      error: typeof error?.clientMessage === 'string' ? error.clientMessage : message,
    })
  }
}

async function handleSwap(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed.' })
    return
  }
  const body = await readJson(request)
  if (!isRecord(body)) {
    sendJson(response, 400, { code: 'INVALID_GENERATION_INPUT', error: 'Request body must be an object.' })
    return
  }
  const configuration = generationConfiguration()
  if (!configuration.configured) {
    sendJson(response, 503, {
      code: 'MODEL_NOT_CONFIGURED',
      error: 'Gemini generation is not configured on this server.',
    })
    return
  }
  const profile = isRecord(body.profile) ? body.profile : {}
  const source = isRecord(body.source) ? body.source : {}
  const currentQuestion = isRecord(body.question) ? body.question : {}
  const reason = cleanString(body.reason, 400)
  const isImageSource = source.kind === 'image'
  const sourceText = cleanString(isImageSource ? source.extractedText : source.content, 12_000)
  let image
  try {
    image = isImageSource ? parseInlineImage(source.content) : undefined
  } catch (error) {
    sendJson(response, 400, {
      code: 'INVALID_GENERATION_INPUT',
      error: error instanceof Error ? error.message : 'The uploaded image could not be read.',
    })
    return
  }
  const rawConstraints = isRecord(body.constraints) ? body.constraints : {}
  const allowedStandards = Array.isArray(rawConstraints.standards)
    ? Array.from(new Set(rawConstraints.standards.map((id) => cleanString(id, 80)).filter(Boolean))).slice(0, 12)
    : []
  const grade = Number(profile.grade)
  const subject = cleanString(profile.subject, 80)
  const topic = cleanString(profile.topic, 120)
  if (
    !Number.isInteger(grade) || grade < 1 || grade > 12 ||
    !subject || !topic ||
    (!isImageSource && !sourceText) ||
    !reason ||
    !cleanString(currentQuestion.id, 120) ||
    !['multiple-choice', 'short-answer', 'extended-response'].includes(currentQuestion.type) ||
    !cleanString(currentQuestion.prompt, 900)
  ) {
    sendJson(response, 400, {
      code: 'INVALID_GENERATION_INPUT',
      error: 'Source material, question id, and teacher revision note are required.',
    })
    return
  }
  const teacherRequest = JSON.stringify({
    grade,
    subject,
    topic,
    sourceKind: isImageSource ? 'uploaded-image' : 'pasted-text',
    sourceText: isImageSource
      ? sourceText || 'Read the attached image directly.'
      : sourceText,
    teacherRevisionNote: reason,
    questionToReplace: {
      type: currentQuestion.type,
      prompt: cleanString(currentQuestion.prompt, 900),
      options: Array.isArray(currentQuestion.options)
        ? currentQuestion.options.map((option) => cleanString(option, 220)).filter(Boolean)
        : [],
      standardIds: Array.isArray(currentQuestion.standardIds)
        ? currentQuestion.standardIds.map((id) => cleanString(id, 80)).filter(Boolean)
        : [],
    },
    allowedStandards,
  })
  try {
    const modelResponse = await geminiGenerate({
      apiKey: configuration.apiKey,
      model: configuration.model,
      maxOutputTokens: 1200,
      timeoutMs: boundedModelTimeout(body.modelTimeoutMs, isImageSource ? 35_000 : 25_000, 35_000),
      instructions: [
        'Create one classroom-ready replacement question grounded in the supplied source and teacher revision note.',
        isImageSource
          ? 'Inspect the attached worksheet image directly and use its exact visible numbers, fractions, decimals, symbols, or problem wording.'
          : 'Use exact evidence from the supplied classroom text.',
        'Preserve the original question type. Return the question itself, never the teacher instruction or a description of what to create.',
        'For multiple choice, provide 3 or 4 matching options with one clearly correct answer. For other types, return an empty options array.',
        'Only use an allowed standard ID. If none fit or none are allowed, use an empty standardIds array.',
      ].join(' '),
      input: teacherRequest,
      image,
      schema: generatedQuestionSchema,
    })
    const parsed = JSON.parse(modelResponse.text)
    const question = validateGeneratedQuestion(
      parsed,
      0,
      reason,
      allowedStandards,
      cleanString(currentQuestion.id, 120),
    )
    if (question.type !== currentQuestion.type) {
      throw new Error('Gemini changed the question type; no changes were committed.')
    }
    sendJson(response, 200, {
      question,
      mode: 'gemini',
      model: modelResponse.model,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gemini replacement generation failed.'
    console.error('Gemini question replacement failed:', message)
    const requestFailed =
      error instanceof TypeError ||
      (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    const code = typeof error?.code === 'string'
      ? error.code
      : requestFailed
        ? 'MODEL_REQUEST_FAILED'
        : 'MODEL_GENERATION_FAILED'
    sendJson(response, 502, {
      code,
      error: typeof error?.clientMessage === 'string' ? error.clientMessage : message,
    })
  }
}

async function readJson(request) {
  const declaredLength = Number(request.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > maximumRequestBytes) {
    throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request body is too large.')
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > maximumRequestBytes) {
      throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request body is too large.')
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must contain valid JSON.')
  }
}

async function handleWorkspace(request, response, id) {
  if (!database) {
    sendJson(response, 503, {
      code: 'PERSISTENCE_UNAVAILABLE',
      error: 'Server persistence is unavailable in this deployment; browser storage remains active.',
    })
    return
  }

  if (request.method === 'GET') {
    const row = database.prepare(
      'SELECT state_json, updated_at FROM workspaces WHERE id = ?',
    ).get(id)
    sendJson(response, 200, {
      workspace: row ? JSON.parse(row.state_json) : null,
      updatedAt: row?.updated_at ?? null,
    })
    return
  }

  if (request.method === 'PUT') {
    const body = await readJson(request)
    if (!isRecord(body) || !isRecord(body.workspace)) {
      sendJson(response, 400, { error: 'workspace must be an object.' })
      return
    }
    const updatedAt = new Date().toISOString()
    database.prepare(`
      INSERT INTO workspaces (id, state_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(id, JSON.stringify(body.workspace), updatedAt)
    sendJson(response, 200, { saved: true, updatedAt })
    return
  }

  if (request.method === 'DELETE') {
    database.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
    sendJson(response, 200, { deleted: true })
    return
  }

  sendJson(response, 405, { error: 'Method not allowed.' })
}

function serveFile(response, requestedPath) {
  const relativePath = requestedPath === '/' ? 'index.html' : requestedPath.slice(1)
  const resolved = normalize(join(distDirectory, relativePath))
  const staysInsideDist = resolved === distDirectory || resolved.startsWith(`${distDirectory}/`)
  const safePath = staysInsideDist && existsSync(resolved) && statSync(resolved).isFile()
    ? resolved
    : join(distDirectory, 'index.html')
  response.writeHead(200, {
    ...securityHeaders(),
    'content-type': contentTypes[extname(safePath)] ?? 'application/octet-stream',
    'cache-control': safePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  createReadStream(safePath).pipe(response)
}

export async function handleRequest(request, response) {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/api/')) validateApiRequest(request)
    const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{20,64})$/i)
    if (workspaceMatch) {
      await handleWorkspace(request, response, workspaceMatch[1])
      return
    }
    if (url.pathname === '/api/generate') {
      await handleGenerate(request, response)
      return
    }
    if (url.pathname === '/api/swap') {
      await handleSwap(request, response)
      return
    }
    if (url.pathname === '/api/health') {
      const configuration = generationConfiguration()
      sendJson(response, 200, {
        ok: true,
        database: database ? 'sqlite' : 'browser',
        aiEnabled: configuration.enabled,
        aiConfigured: configuration.configured,
        model: configuration.configured ? configuration.model : null,
      })
      return
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(response, 404, { code: 'API_NOT_FOUND', error: 'API route not found.' })
      return
    }
    serveFile(response, url.pathname)
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(response, error.status, { code: error.code, error: error.message })
      return
    }
    console.error('Unexpected Classwork server error:', error)
    sendJson(response, 500, { code: 'INTERNAL_ERROR', error: 'Unexpected server error.' })
  }
}

if (process.env.VERCEL !== '1') {
  const server = createServer(handleRequest)
  const port = Number(process.env.CLASSWORK_PORT || 8787)
  server.listen(port, '127.0.0.1', () => {
    const address = server.address()
    const listeningPort = typeof address === 'object' && address ? address.port : port
    console.log(`Classwork server ready at http://127.0.0.1:${listeningPort}`)
  })

  server.requestTimeout = 55_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
}
