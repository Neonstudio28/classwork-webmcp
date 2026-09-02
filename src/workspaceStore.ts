import {
  DEFAULT_CONSTRAINTS,
  DEFAULT_PROFILE,
  EMPTY_WORKSHEET,
  QUESTION_TYPE_LABELS,
  analyzeSourceMaterial,
  createDraftWorksheet,
  evaluateConstraints,
  hasSourceEvidence,
  assertQuestionContent,
  generateReplacementQuestion,
  normalizeQuestionChanges,
  type ActivityActor,
  type ClassProfile,
  type Question,
  type QuestionType,
  type SourceMaterial,
  type WorkspaceState,
  type WorksheetConstraints,
} from './worksheet'
import {
  deleteWorkspaceFromDatabase,
  generateReplacementFromModel,
  generateWorksheetFromModel,
  loadWorkspaceFromDatabase,
  saveWorkspaceToDatabase,
} from './workspaceApi'

const STORAGE_KEY = 'classwork.workspace.v2'
const SUPPORTED_INLINE_IMAGE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/i
const MAX_INLINE_IMAGE_LENGTH = 14_000_000
const EMPTY_TIMESTAMP = new Date(0).toISOString()

const initialState = (modifiedAt = EMPTY_TIMESTAMP): WorkspaceState => ({
  version: 2,
  modifiedAt,
  profile: { ...DEFAULT_PROFILE },
  source: null,
  worksheet: { ...EMPTY_WORKSHEET, questions: [] },
  constraints: {
    ...DEFAULT_CONSTRAINTS,
    questionMix: { ...DEFAULT_CONSTRAINTS.questionMix },
    standards: [...DEFAULT_CONSTRAINTS.standards],
  },
  hasDraft: false,
  activity: [],
  lastAgentMessage: '',
  lastError: '',
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeStoredState(value: unknown): WorkspaceState | null {
  if (!isRecord(value) || value.version !== 2) return null
  const profile = isRecord(value.profile) ? value.profile : null
  const worksheet = isRecord(value.worksheet) ? value.worksheet : null
  const constraints = isRecord(value.constraints) ? value.constraints : null
  const mix = constraints && isRecord(constraints.questionMix) ? constraints.questionMix : null
  if (!profile || !worksheet || !constraints || !mix || !Array.isArray(worksheet.questions)) return null

  const grade = Number(profile.grade)
  const timeLimit = Number(constraints.timeLimit)
  const readingLevel = Number(constraints.readingLevel)
  const questionMix = {
    'multiple-choice': Number(mix['multiple-choice']),
    'short-answer': Number(mix['short-answer']),
    'extended-response': Number(mix['extended-response']),
  }
  const mixTotal = Object.values(questionMix).reduce((sum, item) => sum + item, 0)
  if (
    !Number.isInteger(grade) || grade < 1 || grade > 12 ||
    !Number.isFinite(timeLimit) || timeLimit < 5 || timeLimit > 45 ||
    !Number.isFinite(readingLevel) || readingLevel < 1 || readingLevel > 12 ||
    Object.values(questionMix).some((item) => !Number.isFinite(item) || item < 0 || item > 1) ||
    Math.abs(mixTotal - 1) > 0.02 ||
    worksheet.questions.length > 100
  ) return null

  const questions: Question[] = []
  for (const item of worksheet.questions) {
    if (!isRecord(item)) return null
    const type = item.type
    if (
      typeof item.id !== 'string' || !item.id.trim() || item.id.length > 120 ||
      !['multiple-choice', 'short-answer', 'extended-response'].includes(String(type)) ||
      typeof item.prompt !== 'string' || item.prompt.length > 900 ||
      !Array.isArray(item.standardIds)
    ) return null
    const options = item.options === undefined
      ? undefined
      : Array.isArray(item.options)
        ? item.options.filter((option): option is string => typeof option === 'string').slice(0, 6).map((option) => option.slice(0, 220))
        : null
    if (options === null) return null
    questions.push({
      id: item.id,
      type: type as QuestionType,
      prompt: item.prompt,
      ...(options ? { options } : {}),
      standardIds: item.standardIds
        .filter((standard): standard is string => typeof standard === 'string')
        .map((standard) => standard.trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 8),
    })
  }

  let source: SourceMaterial | null = null
  if (value.source !== null && value.source !== undefined) {
    if (!isRecord(value.source)) return null
    const candidate = value.source
    if (
      !['image', 'text'].includes(String(candidate.kind)) ||
      typeof candidate.content !== 'string' ||
      typeof candidate.name !== 'string' ||
      typeof candidate.subject !== 'string' ||
      typeof candidate.topic !== 'string' ||
      typeof candidate.addedAt !== 'string'
    ) return null
    if (candidate.kind === 'image' && !SUPPORTED_INLINE_IMAGE.test(candidate.content)) return null
    source = {
      kind: candidate.kind as SourceMaterial['kind'],
      content: candidate.content.slice(0, candidate.kind === 'image' ? MAX_INLINE_IMAGE_LENGTH : 12_000),
      extractedText: typeof candidate.extractedText === 'string' ? candidate.extractedText.slice(0, 12_000) : undefined,
      name: candidate.name.slice(0, 120),
      grade,
      subject: candidate.subject.slice(0, 80),
      topic: candidate.topic.slice(0, 120),
      addedAt: candidate.addedAt,
    }
  }

  const activityItems = Array.isArray(value.activity) ? value.activity : []
  const storedActivity = activityItems.filter(isRecord).flatMap((item) =>
    typeof item.id === 'string' &&
    ['teacher', 'agent', 'system'].includes(String(item.actor)) &&
    typeof item.action === 'string' &&
    typeof item.detail === 'string' &&
    typeof item.createdAt === 'string'
      ? [{
          id: item.id.slice(0, 120),
          actor: item.actor as ActivityActor,
          action: item.action.slice(0, 120),
          detail: item.detail.slice(0, 400),
          createdAt: item.createdAt,
        }]
      : [],
  ).slice(0, 10)
  const inferredModifiedAt = [
    typeof value.modifiedAt === 'string' ? value.modifiedAt : '',
    typeof worksheet.updatedAt === 'string' ? worksheet.updatedAt : '',
    source?.addedAt ?? '',
    ...storedActivity.map((item) => item.createdAt),
  ].filter(Boolean).sort().at(-1) ?? EMPTY_TIMESTAMP

  return {
    version: 2,
    modifiedAt: inferredModifiedAt,
    profile: {
      grade,
      subject: String(profile.subject ?? '').slice(0, 80),
      topic: String(profile.topic ?? '').slice(0, 120),
    },
    source,
    worksheet: {
      title: typeof worksheet.title === 'string' ? worksheet.title.slice(0, 100) : '',
      subtitle: typeof worksheet.subtitle === 'string' ? worksheet.subtitle.slice(0, 180) : '',
      questions,
      updatedAt: typeof worksheet.updatedAt === 'string' ? worksheet.updatedAt : EMPTY_TIMESTAMP,
    },
    constraints: {
      timeLimit,
      readingLevel,
      questionMix,
      standards: Array.isArray(constraints.standards)
        ? constraints.standards.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, 80)).filter(Boolean).slice(0, 12)
        : [],
    },
    hasDraft: Boolean(value.hasDraft) && questions.length > 0,
    activity: storedActivity,
    lastAgentMessage: typeof value.lastAgentMessage === 'string' ? value.lastAgentMessage.slice(0, 600) : '',
    lastError: typeof value.lastError === 'string' ? value.lastError.slice(0, 600) : '',
  }
}

function readStoredState() {
  if (typeof window === 'undefined') return initialState()
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (!stored) return initialState()
    const parsed: unknown = JSON.parse(stored)
    return normalizeStoredState(parsed) ?? initialState()
  } catch {
    return initialState()
  }
}

let state = readStoredState()
const listeners = new Set<() => void>()
let databaseSaveTimer = 0
let stateRevision = 0
let databaseOperation = Promise.resolve()
let activeGeneration: symbol | null = null

const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

function safeWriteLocalState(next: WorkspaceState) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch (error) {
    console.warn('Classwork could not cache this update locally.', error)
  }
}

function queueDatabaseOperation(operation: () => Promise<unknown>) {
  databaseOperation = databaseOperation
    .then(operation, operation)
    .then(() => undefined)
}

function cancelScheduledDatabaseSave() {
  if (typeof window === 'undefined') return
  window.clearTimeout(databaseSaveTimer)
  databaseSaveTimer = 0
}

function persist(next: WorkspaceState) {
  if (typeof window === 'undefined') return
  safeWriteLocalState(next)
  cancelScheduledDatabaseSave()
  databaseSaveTimer = window.setTimeout(() => {
    queueDatabaseOperation(() => saveWorkspaceToDatabase(next))
  }, 180)
}

function commit(updater: (current: WorkspaceState) => WorkspaceState) {
  state = { ...updater(state), modifiedAt: new Date().toISOString() }
  stateRevision += 1
  persist(state)
  listeners.forEach((listener) => listener())
}

function beginGeneration() {
  if (activeGeneration) throw new Error('Another worksheet generation is already running.')
  const token = Symbol('classwork-generation')
  activeGeneration = token
  return { token, revision: stateRevision }
}

function ensureGenerationIsCurrent(operation: { token: symbol; revision: number }) {
  if (activeGeneration !== operation.token || stateRevision !== operation.revision) {
    throw new Error('The workspace changed while generation was running. No generated changes were committed.')
  }
}

function finishGeneration(token: symbol) {
  if (activeGeneration === token) activeGeneration = null
}

function activity(
  actor: ActivityActor,
  action: string,
  detail: string,
): WorkspaceState['activity'][number] {
  return {
    id: uid('activity'),
    actor,
    action,
    detail,
    createdAt: new Date().toISOString(),
  }
}

function withActivity(
  current: WorkspaceState,
  item: WorkspaceState['activity'][number],
) {
  return [item, ...current.activity].slice(0, 10)
}

function sourceKind(imageOrText: string): SourceMaterial['kind'] {
  if (/^(?:https?:\/\/|\/\/|\/)/i.test(imageOrText)) {
    throw new Error('Remote image URLs are not supported. Upload the image or provide a supported inline data URL.')
  }
  if (imageOrText.startsWith('data:image/')) {
    if (!SUPPORTED_INLINE_IMAGE.test(imageOrText) || imageOrText.length > MAX_INLINE_IMAGE_LENGTH) {
      throw new Error('Use an inline PNG, JPEG, or WebP image under 10 MB.')
    }
    return 'image'
  }
  return 'text'
}

function mergeConstraints(
  current: WorksheetConstraints,
  changes: Partial<WorksheetConstraints> = {},
): WorksheetConstraints {
  const timeLimit = changes.timeLimit ?? current.timeLimit
  const readingLevel = changes.readingLevel ?? current.readingLevel
  const questionMix = changes.questionMix
    ? { ...changes.questionMix }
    : { ...current.questionMix }
  const mixValues = Object.values(questionMix)
  const mixTotal = mixValues.reduce((sum, value) => sum + value, 0)
  if (!Number.isFinite(timeLimit) || timeLimit < 5 || timeLimit > 45) {
    throw new Error('Completion time must be between 5 and 45 minutes.')
  }
  if (!Number.isFinite(readingLevel) || readingLevel < 1 || readingLevel > 12) {
    throw new Error('Reading level must be between Grade 1 and Grade 12.')
  }
  if (
    mixValues.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
    Math.abs(mixTotal - 1) > 0.02
  ) {
    throw new Error('Question mix values must be ratios from 0 to 1 that add up to 1.')
  }
  return {
    timeLimit,
    readingLevel,
    questionMix,
    standards: Array.from(new Set((changes.standards ?? current.standards)
      .filter((standard): standard is string => typeof standard === 'string')
      .map((standard) => standard.trim().slice(0, 80))
      .filter(Boolean)))
      .slice(0, 12),
  }
}

export const workspaceStore = {
  getSnapshot: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

export const workspaceActions = {
  async hydrate() {
    const hydrationRevision = stateRevision
    const remote = await loadWorkspaceFromDatabase()
    if (stateRevision !== hydrationRevision) return state
    const normalizedRemote = normalizeStoredState(remote)
    if (!normalizedRemote) return state
    const localUpdated = new Date(state.modifiedAt).getTime()
    const remoteUpdated = new Date(normalizedRemote.modifiedAt).getTime()
    if (!Number.isFinite(remoteUpdated) || remoteUpdated <= localUpdated) return state
    state = normalizedRemote
    stateRevision += 1
    safeWriteLocalState(normalizedRemote)
    listeners.forEach((listener) => listener())
    return state
  },

  updateProfile(changes: Partial<ClassProfile>) {
    if (changes.grade !== undefined && !Number.isFinite(changes.grade)) {
      throw new Error('Grade must be a number from 1 to 12.')
    }
    const grade = changes.grade === undefined
      ? state.profile.grade
      : Math.max(1, Math.min(12, Math.round(changes.grade)))
    const subject = changes.subject === undefined
      ? state.profile.subject
      : changes.subject.trimStart().slice(0, 80)
    const topic = changes.topic === undefined
      ? state.profile.topic
      : changes.topic.trimStart().slice(0, 120)
    commit((current) => ({
      ...current,
      profile: { grade, subject, topic },
      source: current.source
        ? { ...current.source, grade, subject, topic }
        : null,
      constraints: changes.grade === undefined
        ? current.constraints
        : { ...current.constraints, readingLevel: grade },
    }))
    return state.profile
  },

  addSourceMaterial(
    imageOrText: string,
    grade: number,
    subject: string,
    topic: string,
    name = 'Classroom source',
    actor: ActivityActor = 'teacher',
    extractedText?: string,
  ) {
    if (!Number.isInteger(grade) || grade < 1 || grade > 12) {
      throw new Error('Grade must be a whole number from 1 to 12.')
    }
    const cleanedSubject = subject.trim().slice(0, 80)
    const cleanedTopic = topic.trim().slice(0, 120)
    const cleaned = imageOrText.trim()
    if (!cleaned) throw new Error('Source material cannot be empty.')
    const kind = sourceKind(cleaned)
    const nextSource: SourceMaterial = {
      kind,
      content: kind === 'text' ? cleaned.slice(0, 12_000) : cleaned,
      extractedText: extractedText?.trim().slice(0, 12_000) || undefined,
      name: name.slice(0, 120),
      grade,
      subject: cleanedSubject,
      topic: cleanedTopic,
      addedAt: new Date().toISOString(),
    }
    commit((current) => ({
      ...current,
      profile: { grade, subject: cleanedSubject, topic: cleanedTopic },
      source: nextSource,
      hasDraft: false,
      lastError: '',
      activity: withActivity(
        current,
        activity(actor, 'Added source material', `${nextSource.name} · Grade ${grade}${cleanedSubject ? ` ${cleanedSubject}` : ''}`),
      ),
    }))
    return nextSource
  },

  removeSource() {
    commit((current) => ({
      ...current,
      source: null,
      worksheet: { ...EMPTY_WORKSHEET, questions: [] },
      hasDraft: false,
      lastAgentMessage: '',
      lastError: '',
      activity: withActivity(
        current,
        activity(
          'teacher',
          'Removed source material',
          `${current.source?.name ?? 'Class material'} · class fit kept`,
        ),
      ),
    }))
  },

  updateSourceTranscript(transcript: string) {
    if (!state.source || state.source.kind !== 'image') {
      throw new Error('Add an image source before editing its transcript.')
    }
    const extractedText = transcript.trimStart().slice(0, 12_000)
    commit((current) => ({
      ...current,
      source: current.source
        ? { ...current.source, extractedText: extractedText || undefined }
        : current.source,
      hasDraft: false,
      lastError: '',
    }))
    return workspaceStore.getSnapshot().source
  },

  setConstraints(changes: Partial<WorksheetConstraints>) {
    const nextConstraints = mergeConstraints(state.constraints, changes)
    commit((current) => ({
      ...current,
      constraints: nextConstraints,
    }))
  },

  async generateDraft(
    constraints?: Partial<WorksheetConstraints>,
    actor: ActivityActor = 'agent',
    modelTimeoutMs?: number,
  ) {
    if (!state.source) {
      throw new Error('Add source material before generating a draft.')
    }
    if (!state.profile.subject.trim() || !state.profile.topic.trim()) {
      throw new Error('Set the subject and topic before generating a draft.')
    }
    const source = state.source
    const profile = { ...state.profile }
    const nextConstraints = mergeConstraints(state.constraints, constraints)
    const operation = beginGeneration()
    try {
      let sourceAnalysis = analyzeSourceMaterial(source)
      let worksheet
      let generationMode = 'Gemini'
      let generationModel = ''
      let extractedVisionText = ''
      try {
        const generated = await generateWorksheetFromModel({
          profile,
          source,
          constraints: nextConstraints,
        }, modelTimeoutMs)
        ensureGenerationIsCurrent(operation)
        worksheet = generated.worksheet
        generationModel = generated.model
        extractedVisionText = generated.sourceEvidence.join('\n').slice(0, 12_000)
        if (source.kind === 'image' && extractedVisionText) {
          sourceAnalysis = analyzeSourceMaterial({
            ...source,
            extractedText: extractedVisionText,
          })
        }
      } catch (error) {
        ensureGenerationIsCurrent(operation)
        const modelError = error as Error & { code?: string }
        const requestFailed = modelError.code === 'MODEL_REQUEST_FAILED'
        const rateLimited = modelError.code === 'MODEL_RATE_LIMITED'
        if (!requestFailed && !rateLimited && !['MODEL_NOT_CONFIGURED', 'API_UNAVAILABLE'].includes(modelError.code ?? '')) {
          throw new Error(`Gemini generation failed: ${modelError.message}`)
        }
        generationMode = requestFailed || rateLimited
          ? source.kind === 'image'
            ? hasSourceEvidence(sourceAnalysis)
              ? `image-transcript local fallback after Gemini ${rateLimited ? 'rate limit' : 'image request failure'}`
              : `topic-only fallback after Gemini ${rateLimited ? 'rate limit' : 'image request failure'}`
            : `source-grounded local fallback after Gemini ${rateLimited ? 'rate limit' : 'request failure'}`
          : source.kind === 'image'
            ? hasSourceEvidence(sourceAnalysis)
              ? 'image-transcript local fallback'
              : 'topic-only local fallback'
            : 'source-grounded local fallback'
        worksheet = createDraftWorksheet(profile, source, nextConstraints.standards)
      }
      worksheet.questions.forEach((question) => assertQuestionContent(question))
      const nextSnapshot = evaluateConstraints(worksheet, nextConstraints)
      const needsAttention = nextSnapshot.total - nextSnapshot.satisfiedCount
      const grounded = hasSourceEvidence(sourceAnalysis)
      ensureGenerationIsCurrent(operation)
      commit((current) => ({
        ...current,
        source:
          current.source?.kind === 'image' && extractedVisionText
            ? { ...current.source, extractedText: extractedVisionText }
            : current.source,
        constraints: nextConstraints,
        worksheet,
        hasDraft: true,
        lastError: '',
        lastAgentMessage:
          `Drafted six ${grounded ? 'source-grounded' : 'topic-guided'} questions with ${generationMode}${generationModel ? ` (${generationModel})` : ''}. ${needsAttention === 0 ? 'All checks are satisfied.' : `${needsAttention} ${needsAttention === 1 ? 'check needs' : 'checks need'} attention.`}`,
        activity: withActivity(
          current,
          activity(
            actor,
            generationMode === 'Gemini'
              ? 'Generated source-grounded draft with Gemini'
              : grounded
                ? 'Generated source-grounded local fallback'
                : 'Generated topic-guided local fallback',
            `${sourceAnalysis.focus.join(', ')} · ${needsAttention} ${needsAttention === 1 ? 'check needs' : 'checks need'} attention`,
          ),
        ),
      }))
      return worksheet
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The draft could not be generated.'
      if (activeGeneration === operation.token && stateRevision === operation.revision) {
        commit((current) => ({ ...current, lastError: message }))
      }
      throw new Error(message)
    } finally {
      finishGeneration(operation.token)
    }
  },

  editQuestion(
    id: string,
    changes: Partial<Pick<Question, 'prompt' | 'type' | 'options' | 'standardIds'>>,
    actor: ActivityActor = 'teacher',
    logChange = true,
  ) {
    const index = state.worksheet.questions.findIndex((question) => question.id === id)
    if (index < 0) throw new Error(`Question ${id} was not found.`)
    let normalized: Partial<Question>
    try {
      normalized = normalizeQuestionChanges(changes)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The question wording could not be updated.'
      commit((current) => ({ ...current, lastError: message }))
      throw new Error(message)
    }
    commit((current) => {
      const questions = current.worksheet.questions.map((question) =>
        question.id === id ? { ...question, ...normalized } : question,
      )
      const next = {
        ...current,
        worksheet: {
          ...current.worksheet,
          questions,
          updatedAt: new Date().toISOString(),
        },
        lastError: '',
      }
      if (!logChange) return next
      const changedField = normalized.type
        ? `type to ${QUESTION_TYPE_LABELS[normalized.type]}`
        : normalized.standardIds
          ? 'standard alignment'
          : 'question wording'
      return {
        ...next,
        activity: withActivity(
          current,
          activity(actor, 'Edited question', `Question ${index + 1} · ${changedField}`),
        ),
      }
    })
    return workspaceStore.getSnapshot().worksheet.questions.find(
      (question) => question.id === id,
    )!
  },

  logQuestionRewrite(id: string) {
    const index = state.worksheet.questions.findIndex((question) => question.id === id)
    if (index < 0) return
    commit((current) => ({
      ...current,
      activity: withActivity(
        current,
        activity('teacher', 'Rewrote question', `Question ${index + 1} · direct edit`),
      ),
    }))
  },

  async swapQuestion(
    id: string,
    reason: string,
    actor: ActivityActor = 'agent',
    modelTimeoutMs?: number,
  ) {
    const currentQuestion = state.worksheet.questions.find(
      (question) => question.id === id,
    )
    if (!currentQuestion) throw new Error(`Question ${id} was not found.`)
    if (!state.source) throw new Error('Add source material before swapping a question.')
    const cleanedReason = reason.trim().slice(0, 400)
    if (!cleanedReason) throw new Error('Name the change for the replacement question.')
    const source = state.source
    const profile = { ...state.profile }
    const constraints = mergeConstraints(state.constraints)
    const operation = beginGeneration()
    try {
      let replacement: Question
      let generationMode = 'Gemini'
      let generationModel = ''
      try {
        const generated = await generateReplacementFromModel({
          profile,
          source,
          constraints,
          question: currentQuestion,
          reason: cleanedReason,
        }, modelTimeoutMs)
        ensureGenerationIsCurrent(operation)
        replacement = assertQuestionContent(generated.question, cleanedReason)
        generationModel = generated.model
      } catch (error) {
        ensureGenerationIsCurrent(operation)
        const modelError = error as Error & { code?: string }
        if (!['MODEL_NOT_CONFIGURED', 'MODEL_REQUEST_FAILED', 'MODEL_RATE_LIMITED', 'API_UNAVAILABLE'].includes(modelError.code ?? '')) {
          throw new Error(modelError.message || 'The replacement could not be generated.')
        }
        generationMode = modelError.code === 'MODEL_REQUEST_FAILED'
          ? 'local fallback after Gemini request failure'
          : modelError.code === 'MODEL_RATE_LIMITED'
            ? 'local fallback after Gemini rate limit'
            : 'local fallback'
        replacement = assertQuestionContent(
          generateReplacementQuestion(currentQuestion, cleanedReason),
          cleanedReason,
        )
      }
      const wantsDecimals = /decimal|hundredth|place value|compare/i.test(cleanedReason)
      ensureGenerationIsCurrent(operation)
      commit((current) => {
        const index = current.worksheet.questions.findIndex(
          (question) => question.id === id,
        )
        if (index < 0) throw new Error(`Question ${id} was removed while generation was running.`)
        return {
          ...current,
          worksheet: {
            ...current.worksheet,
            questions: current.worksheet.questions.map((question) =>
              question.id === id ? replacement : question,
            ),
            updatedAt: new Date().toISOString(),
          },
          lastError: '',
          lastAgentMessage: `Swapped Question ${index + 1} with ${generationMode}${generationModel ? ` (${generationModel})` : ''} for a ${wantsDecimals ? 'decimal' : 'source'}-focused ${QUESTION_TYPE_LABELS[replacement.type].toLowerCase()} item.`,
          activity: withActivity(
            current,
            activity(
              actor,
              'Ran swap_question',
              `Question ${index + 1} · ${generationMode} · ${wantsDecimals ? 'fractions → decimals' : cleanedReason.slice(0, 70)}`,
            ),
          ),
        }
      })
      return replacement
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The replacement could not be generated.'
      if (activeGeneration === operation.token && stateRevision === operation.revision) {
        commit((current) => ({ ...current, lastError: message }))
      }
      throw new Error(message)
    } finally {
      finishGeneration(operation.token)
    }
  },

  deleteQuestion(id: string, actor: ActivityActor = 'teacher') {
    const index = state.worksheet.questions.findIndex((question) => question.id === id)
    if (index < 0) throw new Error(`Question ${id} was not found.`)
    commit((current) => ({
      ...current,
      worksheet: {
        ...current.worksheet,
        questions: current.worksheet.questions.filter((question) => question.id !== id),
        updatedAt: new Date().toISOString(),
      },
      lastError: '',
      activity: withActivity(
        current,
        activity(actor, 'Removed question', `Question ${index + 1} · direct board action`),
      ),
    }))
  },

  moveQuestion(id: string, toIndex: number, actor: ActivityActor = 'teacher') {
    const fromIndex = state.worksheet.questions.findIndex((question) => question.id === id)
    if (fromIndex < 0) throw new Error(`Question ${id} was not found.`)
    const boundedIndex = Math.max(
      0,
      Math.min(toIndex, state.worksheet.questions.length - 1),
    )
    if (fromIndex === boundedIndex) return
    commit((current) => {
      const questions = [...current.worksheet.questions]
      const [moved] = questions.splice(fromIndex, 1)
      questions.splice(boundedIndex, 0, moved)
      return {
        ...current,
        worksheet: {
          ...current.worksheet,
          questions,
          updatedAt: new Date().toISOString(),
        },
        activity: withActivity(
          current,
          activity(
            actor,
            'Reordered question',
            `Question ${fromIndex + 1} → position ${boundedIndex + 1}`,
          ),
        ),
      }
    })
  },

  addQuestion(type: QuestionType = 'short-answer', actor: ActivityActor = 'teacher') {
    const topic = state.profile.topic || 'the lesson topic'
    const standardIds = state.constraints.standards.length
      ? [state.constraints.standards[0]]
      : []
    const questionContent: Record<QuestionType, Omit<Question, 'id' | 'type'>> = {
      'multiple-choice': {
        prompt: `Which statement best explains ${topic}?`,
        options: ['A source-supported explanation', 'An unrelated detail', 'An unsupported claim', 'A contradiction'],
        standardIds,
      },
      'short-answer': {
        prompt: `Use evidence from the class material to explain ${topic}.`,
        standardIds,
      },
      'extended-response': {
        prompt: `Apply what you learned about ${topic} to a new example, then justify your reasoning with source evidence.`,
        standardIds,
      },
    }
    const question: Question = { id: uid('q'), type, ...questionContent[type] }
    commit((current) => ({
      ...current,
      worksheet: {
        ...current.worksheet,
        questions: [...current.worksheet.questions, question],
        updatedAt: new Date().toISOString(),
      },
      hasDraft: true,
      lastError: '',
      activity: withActivity(
        current,
        activity(actor, 'Added question', QUESTION_TYPE_LABELS[type]),
      ),
    }))
    return question
  },

  setWorksheetTitle(title: string) {
    commit((current) => ({
      ...current,
      worksheet: {
        ...current.worksheet,
        title: title.slice(0, 100),
        updatedAt: new Date().toISOString(),
      },
    }))
  },

  setAgentMessage(message: string) {
    commit((current) => ({ ...current, lastAgentMessage: message, lastError: '' }))
  },

  setError(message: string) {
    commit((current) => ({ ...current, lastError: message }))
  },

  reset() {
    const next = initialState(new Date().toISOString())
    cancelScheduledDatabaseSave()
    state = next
    stateRevision += 1
    safeWriteLocalState(next)
    queueDatabaseOperation(deleteWorkspaceFromDatabase)
    listeners.forEach((listener) => listener())
  },
}

export async function runAgentInstruction(instruction: string) {
  const cleaned = instruction.trim()
  if (!cleaned) throw new Error('Enter an instruction for the agent.')
  if (!state.hasDraft) throw new Error('Generate a draft before asking for revisions.')

  if (/swap|replace|change/i.test(cleaned)) {
    const fractionQuestion = state.worksheet.questions.find((question) =>
      /fraction|\/10|\/100|denominator/i.test(question.prompt),
    )
    const target = fractionQuestion ?? state.worksheet.questions[0]
    return await workspaceActions.swapQuestion(target.id, cleaned, 'agent')
  }

  if (/shorter|too long|reduce time/i.test(cleaned)) {
    const extended = [...state.worksheet.questions]
      .reverse()
      .find((question) => question.type === 'extended-response')
    if (!extended) {
      workspaceActions.setAgentMessage('There is no extended-response item left to remove.')
      return null
    }
    workspaceActions.deleteQuestion(extended.id, 'agent')
    workspaceActions.setAgentMessage(
      'Removed the final extended-response item and reran all four checks.',
    )
    return extended
  }

  if (/add.*multiple|more.*multiple/i.test(cleaned)) {
    const question = workspaceActions.addQuestion('multiple-choice', 'agent')
    workspaceActions.setAgentMessage('Added one multiple-choice item and reran the checks.')
    return question
  }

  workspaceActions.setAgentMessage(
    'I can swap a question, shorten the worksheet, or add a multiple-choice item. Name the concept and the change you want.',
  )
  return null
}

export function currentConstraintSnapshot() {
  return evaluateConstraints(state.worksheet, state.constraints)
}
