import type {
  ClassProfile,
  SourceMaterial,
  Worksheet,
  WorksheetConstraints,
  WorkspaceState,
} from './worksheet'

const WORKSPACE_ID_KEY = 'classwork.workspace.id'
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
let inMemoryWorkspaceId = ''

function workspaceId() {
  try {
    const existing = window.localStorage.getItem(WORKSPACE_ID_KEY)
    if (existing && WORKSPACE_ID_PATTERN.test(existing)) return existing
    const created = crypto.randomUUID()
    window.localStorage.setItem(WORKSPACE_ID_KEY, created)
    return created
  } catch {
    if (!inMemoryWorkspaceId) inMemoryWorkspaceId = crypto.randomUUID()
    return inMemoryWorkspaceId
  }
}

async function request(path: string, init?: RequestInit, timeoutMs = 15_000) {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch {
    const error = new Error('The local Classwork API is unavailable.') as Error & {
      code?: string
    }
    error.code = 'API_UNAVAILABLE'
    throw error
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as {
      code?: string
      error?: string
    }
    const error = new Error(payload.error || `Workspace API returned ${response.status}.`) as Error & {
      code?: string
    }
    error.code = payload.code
    throw error
  }
  return response
}

export interface ModelGenerationResult {
  worksheet: Worksheet
  mode: 'gemini'
  model: string
  sourceEvidence: string[]
  sourceMode: 'image-vision' | 'source-text'
}

export async function generateWorksheetFromModel(input: {
  profile: ClassProfile
  source: SourceMaterial
  constraints: WorksheetConstraints
}, modelTimeoutMs?: number) {
  const requestTimeoutMs = modelTimeoutMs ?? (input.source.kind === 'image' ? 45_000 : 25_000)
  const response = await request('/api/generate', {
    method: 'POST',
    body: JSON.stringify({ ...input, modelTimeoutMs }),
  }, requestTimeoutMs + 5_000)
  const payload = await response.json() as Partial<ModelGenerationResult>
  if (
    !payload.worksheet ||
    !Array.isArray(payload.worksheet.questions) ||
    !Array.isArray(payload.sourceEvidence) ||
    typeof payload.model !== 'string'
  ) {
    const error = new Error('The generation API returned an invalid worksheet payload.') as Error & { code?: string }
    error.code = 'INVALID_API_RESPONSE'
    throw error
  }
  return payload as ModelGenerationResult
}

export async function generateReplacementFromModel(input: {
  profile: ClassProfile
  source: SourceMaterial
  constraints: WorksheetConstraints
  question: WorkspaceState['worksheet']['questions'][number]
  reason: string
}, modelTimeoutMs?: number) {
  const requestTimeoutMs = modelTimeoutMs ?? (input.source.kind === 'image' ? 35_000 : 25_000)
  const response = await request('/api/swap', {
    method: 'POST',
    body: JSON.stringify({ ...input, modelTimeoutMs }),
  }, requestTimeoutMs + 5_000)
  const payload = await response.json() as Partial<{
    question: WorkspaceState['worksheet']['questions'][number]
    mode: 'gemini'
    model: string
  }>
  if (!payload.question || typeof payload.question !== 'object' || typeof payload.model !== 'string') {
    const error = new Error('The generation API returned an invalid replacement payload.') as Error & { code?: string }
    error.code = 'INVALID_API_RESPONSE'
    throw error
  }
  return payload as {
    question: WorkspaceState['worksheet']['questions'][number]
    mode: 'gemini'
    model: string
  }
}

export async function loadWorkspaceFromDatabase() {
  try {
    const response = await request(`/api/workspaces/${workspaceId()}`)
    const payload = await response.json() as { workspace?: WorkspaceState | null }
    return payload.workspace ?? null
  } catch {
    return null
  }
}

export async function saveWorkspaceToDatabase(workspace: WorkspaceState) {
  try {
    await request(`/api/workspaces/${workspaceId()}`, {
      method: 'PUT',
      body: JSON.stringify({ workspace }),
    })
    return true
  } catch {
    return false
  }
}

export async function deleteWorkspaceFromDatabase() {
  try {
    await request(`/api/workspaces/${workspaceId()}`, { method: 'DELETE' })
    return true
  } catch {
    return false
  }
}
