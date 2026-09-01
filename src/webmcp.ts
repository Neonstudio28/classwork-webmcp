import {
  checkQuestionMix,
  checkReadingLevel,
  checkStandardCoverage,
  checkTimeEstimate,
  evaluateConstraints,
  analyzeSourceMaterial,
  sourceGroundingLabel,
  type Question,
  type Worksheet,
  type WorksheetConstraints,
} from './worksheet'
import {
  currentConstraintSnapshot,
  workspaceActions,
  workspaceStore,
} from './workspaceStore'

type JsonSchema = Record<string, unknown>

interface WebMcpTool {
  name: string
  title?: string
  description: string
  inputSchema: JsonSchema
  annotations?: {
    readOnlyHint?: boolean
    untrustedContentHint?: boolean
  }
  execute(input: unknown): unknown | Promise<unknown>
}

interface ModelContextApi {
  registerTool(
    tool: WebMcpTool,
    options?: { signal?: AbortSignal },
  ): void | Promise<void>
}

declare global {
  interface Document {
    readonly modelContext?: ModelContextApi
  }
}

type ToolStatus =
  | { state: 'checking'; count: 0; message: string }
  | { state: 'ready'; count: number; message: string }
  | { state: 'unsupported'; count: 0; message: string }
  | { state: 'error'; count: number; message: string }

function isAbortError(error: unknown) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError',
  )
}

const questionSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 120 },
    type: {
      type: 'string',
      enum: ['multiple-choice', 'short-answer', 'extended-response'],
    },
    prompt: { type: 'string', minLength: 1, maxLength: 900 },
    options: { type: 'array', items: { type: 'string', maxLength: 220 }, maxItems: 6 },
    standardIds: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 8 },
  },
  required: ['id', 'type', 'prompt', 'standardIds'],
  additionalProperties: false,
}

const worksheetInputSchema: JsonSchema = {
  oneOf: [
    {
      type: 'string',
      const: 'current',
      description: 'Use the worksheet currently visible on the Classwork board.',
    },
    {
      type: 'object',
      properties: {
        title: { type: 'string' },
        subtitle: { type: 'string' },
        questions: { type: 'array', items: questionSchema, maxItems: 100 },
        updatedAt: { type: 'string' },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  ],
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object input.')
  }
  return value as Record<string, unknown>
}

function asNonEmptyString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`)
  }
  return value.trim()
}

function asBoundedString(value: unknown, field: string, maximum: number) {
  const result = asNonEmptyString(value, field)
  if (result.length > maximum) throw new Error(`${field} must be ${maximum} characters or fewer.`)
  return result
}

function asStandardList(value: unknown, field = 'standards') {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    throw new Error(`${field} must contain between 1 and 12 identifiers.`)
  }
  return Array.from(new Set(value.map((item, index) =>
    asBoundedString(item, `${field}[${index}]`, 80),
  )))
}

function parseQuestion(value: unknown, index: number): Question {
  const record = asRecord(value)
  const type = record.type
  if (!['multiple-choice', 'short-answer', 'extended-response'].includes(String(type))) {
    throw new Error(`worksheet.questions[${index}].type is invalid.`)
  }
  let options: string[] | undefined
  if (record.options !== undefined) {
    if (!Array.isArray(record.options) || record.options.length > 6) {
      throw new Error(`worksheet.questions[${index}].options must contain at most 6 items.`)
    }
    options = record.options.map((item, optionIndex) =>
      asBoundedString(item, `worksheet.questions[${index}].options[${optionIndex}]`, 220),
    )
  }
  let standardIds: string[] = []
  if (record.standardIds !== undefined) {
    if (!Array.isArray(record.standardIds) || record.standardIds.length > 8) {
      throw new Error(`worksheet.questions[${index}].standardIds must contain at most 8 items.`)
    }
    standardIds = record.standardIds.map((item, standardIndex) =>
      asBoundedString(item, `worksheet.questions[${index}].standardIds[${standardIndex}]`, 80),
    )
  }
  return {
    id: asBoundedString(record.id, `worksheet.questions[${index}].id`, 120),
    type: type as Question['type'],
    prompt: asBoundedString(record.prompt, `worksheet.questions[${index}].prompt`, 900),
    ...(options ? { options } : {}),
    standardIds,
  }
}

function resolveWorksheet(value: unknown): Pick<Worksheet, 'questions'> {
  if (value === 'current') return workspaceStore.getSnapshot().worksheet
  const record = asRecord(value)
  if (!Array.isArray(record.questions) || record.questions.length > 100) {
    throw new Error('worksheet.questions must be an array.')
  }
  return { questions: record.questions.map(parseQuestion) }
}

function conciseState() {
  const current = workspaceStore.getSnapshot()
  const checks = currentConstraintSnapshot()
  return {
    questionCount: current.worksheet.questions.length,
    satisfiedChecks: `${checks.satisfiedCount}/${checks.total}`,
    checks: {
      time: checks.time.status,
      readingLevel: checks.reading.status,
      questionMix: checks.mix.status,
      standards: checks.coverage.status,
    },
  }
}

export const toolHandlers = {
  addSourceMaterial(input: unknown) {
    const record = asRecord(input)
    const imageOrText = asBoundedString(record.image_or_text, 'image_or_text', 14_000_000)
    const grade = Number(record.grade)
    const subject = asBoundedString(record.subject, 'subject', 80)
    const topic = asBoundedString(record.topic, 'topic', 120)
    const extractedText = record.extracted_text === undefined
      ? undefined
      : asBoundedString(record.extracted_text, 'extracted_text', 12_000)
    const source = workspaceActions.addSourceMaterial(
      imageOrText,
      grade,
      subject,
      topic,
      'Added by classroom agent',
      'agent',
      extractedText,
    )
    return {
      source: { kind: source.kind, grade: source.grade, subject: source.subject, topic: source.topic },
      visibleState: conciseState(),
    }
  },

  readWorkspaceState() {
    const current = workspaceStore.getSnapshot()
    const checks = currentConstraintSnapshot()
    const sourceAnalysis = current.source
      ? analyzeSourceMaterial(current.source)
      : null
    return {
      source: current.source
        ? {
            kind: current.source.kind,
            name: current.source.name,
            grade: current.source.grade,
            subject: current.source.subject,
            topic: current.source.topic,
            grounding: sourceAnalysis
              ? sourceGroundingLabel(sourceAnalysis)
              : null,
            sourceText:
              current.source.kind === 'text'
                ? current.source.content
                : current.source.extractedText ?? null,
          }
        : null,
      constraints: current.constraints,
      profile: current.profile,
      worksheet: current.worksheet,
      checks,
      hasDraft: current.hasDraft,
    }
  },

  async generateDraft(input: unknown) {
    const record = asRecord(input)
    const rawConstraints = asRecord(record.constraints)
    const questionMix = asRecord(rawConstraints.question_mix)
    const constraints: Partial<WorksheetConstraints> = {
      timeLimit: Number(rawConstraints.time_limit),
      readingLevel: Number(rawConstraints.reading_level),
      questionMix: {
        'multiple-choice': Number(questionMix['multiple-choice']),
        'short-answer': Number(questionMix['short-answer']),
        'extended-response': Number(questionMix['extended-response']),
      },
      standards: asStandardList(rawConstraints.standards),
    }
    if (!Number.isFinite(constraints.timeLimit) || constraints.timeLimit! < 5 || constraints.timeLimit! > 45) {
      throw new Error('time_limit must be between 5 and 45.')
    }
    if (!Number.isFinite(constraints.readingLevel) || constraints.readingLevel! < 1 || constraints.readingLevel! > 12) {
      throw new Error('reading_level must be between 1 and 12.')
    }
    const mixValues = Object.values(constraints.questionMix!)
    if (
      mixValues.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
      Math.abs(mixValues.reduce((sum, value) => sum + value, 0) - 1) > 0.02
    ) {
      throw new Error('question_mix values must be ratios from 0 to 1 that add up to 1.')
    }
    const worksheet = await workspaceActions.generateDraft(constraints, 'agent', 14_000)
    return {
      worksheet: { title: worksheet.title, questionCount: worksheet.questions.length },
      visibleState: conciseState(),
    }
  },

  editQuestion(input: unknown) {
    const record = asRecord(input)
    const id = asBoundedString(record.id, 'id', 120)
    const rawChanges = asRecord(record.changes)
    const allowedChangeKeys = ['prompt', 'type', 'options', 'standardIds']
    if (!Object.keys(rawChanges).length || Object.keys(rawChanges).some((key) => !allowedChangeKeys.includes(key))) {
      throw new Error('changes must contain only prompt, type, options, or standardIds.')
    }
    if (rawChanges.prompt !== undefined && typeof rawChanges.prompt !== 'string') throw new Error('changes.prompt must be a string.')
    if (rawChanges.type !== undefined && !['multiple-choice', 'short-answer', 'extended-response'].includes(String(rawChanges.type))) throw new Error('changes.type is invalid.')
    if (rawChanges.options !== undefined && (!Array.isArray(rawChanges.options) || rawChanges.options.length > 6)) throw new Error('changes.options must contain at most 6 strings.')
    if (rawChanges.standardIds !== undefined && (!Array.isArray(rawChanges.standardIds) || rawChanges.standardIds.length > 8)) throw new Error('changes.standardIds must contain at most 8 strings.')
    const changes = rawChanges as Partial<Pick<Question, 'prompt' | 'type' | 'options' | 'standardIds'>>
    const question = workspaceActions.editQuestion(id, changes, 'agent', true)
    return { question, visibleState: conciseState() }
  },

  async swapQuestion(input: unknown) {
    const record = asRecord(input)
    const id = asBoundedString(record.id, 'id', 120)
    const reason = asBoundedString(record.reason, 'reason', 400)
    const question = await workspaceActions.swapQuestion(id, reason, 'agent', 14_000)
    return { question, visibleState: conciseState() }
  },

  checkTime(input: unknown) {
    const record = asRecord(input)
    const worksheet = resolveWorksheet(record.worksheet)
    const current = workspaceStore.getSnapshot()
    const result = evaluateConstraints(worksheet, current.constraints).time
    return { ...result, unit: 'minutes' }
  },

  checkReading(input: unknown) {
    const record = asRecord(input)
    const worksheet = resolveWorksheet(record.worksheet)
    const current = workspaceStore.getSnapshot()
    const raw = checkReadingLevel(worksheet)
    const result = evaluateConstraints(worksheet, current.constraints).reading
    return {
      ...result,
      heuristic: {
        averageSentenceLength: raw.averageSentenceLength,
        longWordRatio: raw.longWordRatio,
      },
    }
  },

  checkMix(input: unknown) {
    const record = asRecord(input)
    const worksheet = resolveWorksheet(record.worksheet)
    const target = workspaceStore.getSnapshot().constraints.questionMix
    return checkQuestionMix(worksheet, target)
  },

  checkCoverage(input: unknown) {
    const record = asRecord(input)
    const worksheet = resolveWorksheet(record.worksheet)
    return checkStandardCoverage(worksheet, asStandardList(record.standards))
  },
}

const tools: WebMcpTool[] = [
  {
    name: 'add_source_material',
    title: 'Add source material',
    description:
      'Stage an inline PNG, JPEG, or WebP data URL, or pasted classroom text, for a configurable grade, subject, and topic. Remote image URLs are rejected. This updates the same persisted workspace visible to the teacher but does not generate questions.',
    inputSchema: {
      type: 'object',
      properties: {
        image_or_text: {
          type: 'string',
          maxLength: 14000000,
          description: 'Inline PNG, JPEG, or WebP data URL, or source text to use. Remote URLs are not accepted.',
        },
        grade: { type: 'integer', minimum: 1, maximum: 12 },
        subject: { type: 'string', minLength: 1, maxLength: 80 },
        topic: { type: 'string', minLength: 1, maxLength: 120 },
        extracted_text: {
          type: 'string',
          maxLength: 12000,
          description:
            'Optional transcription when image_or_text is an image. Supplying it grounds draft examples without requiring local OCR.',
        },
      },
      required: ['image_or_text', 'grade', 'subject', 'topic'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: toolHandlers.addSourceMaterial,
  },
  {
    name: 'generate_draft',
    title: 'Generate worksheet draft',
    description:
      'Create and display a source-grounded worksheet using explicit time, reading, mix, and standards constraints. For an uploaded image source, Gemini reads the image bytes directly and extracts visible content before generating.',
    inputSchema: {
      type: 'object',
      properties: {
        constraints: {
          type: 'object',
          properties: {
            time_limit: { type: 'number', minimum: 5, maximum: 45 },
            reading_level: { type: 'number', minimum: 1, maximum: 12 },
            question_mix: {
              type: 'object',
              properties: {
                'multiple-choice': { type: 'number', minimum: 0, maximum: 1 },
                'short-answer': { type: 'number', minimum: 0, maximum: 1 },
                'extended-response': { type: 'number', minimum: 0, maximum: 1 },
              },
              required: ['multiple-choice', 'short-answer', 'extended-response'],
              additionalProperties: false,
            },
            standards: { type: 'array', items: { type: 'string', maxLength: 80 }, minItems: 1, maxItems: 12 },
          },
          required: ['time_limit', 'reading_level', 'question_mix', 'standards'],
          additionalProperties: false,
        },
      },
      required: ['constraints'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: toolHandlers.generateDraft,
  },
  {
    name: 'edit_question',
    title: 'Edit a worksheet question',
    description:
      'Update one visible worksheet question by stable id. Use for wording, question type, answer options, or standards alignment.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 120 },
        changes: {
          type: 'object',
          properties: {
            prompt: { type: 'string', maxLength: 900 },
            type: {
              type: 'string',
              enum: ['multiple-choice', 'short-answer', 'extended-response'],
            },
            options: { type: 'array', items: { type: 'string', maxLength: 220 }, maxItems: 6 },
            standardIds: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 8 },
          },
          additionalProperties: false,
        },
      },
      required: ['id', 'changes'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: toolHandlers.editQuestion,
  },
  {
    name: 'swap_question',
    title: 'Swap a worksheet question',
    description:
      'Replace one visible question while preserving its position and question type. The reason names the concept and revision the teacher wants.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 120 },
        reason: { type: 'string', minLength: 1, maxLength: 400 },
      },
      required: ['id', 'reason'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: toolHandlers.swapQuestion,
  },
  {
    name: 'read_workspace_state',
    title: 'Read current Classwork workspace',
    description:
      'Read the complete visible Classwork state before deciding what to change: source metadata, constraints, stable question IDs and content, plus all four live check results.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: toolHandlers.readWorkspaceState,
  },
  {
    name: 'check_time_estimate',
    title: 'Check completion time',
    description:
      'Estimate completion minutes from question types and reading word count. Pass "current" to inspect the live board or provide a worksheet object.',
    inputSchema: {
      type: 'object',
      properties: { worksheet: worksheetInputSchema },
      required: ['worksheet'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: toolHandlers.checkTime,
  },
  {
    name: 'check_reading_level',
    title: 'Check reading level',
    description:
      'Estimate the worksheet reading grade using sentence length and long-word frequency. Pass "current" to inspect the live board or provide a worksheet object.',
    inputSchema: {
      type: 'object',
      properties: { worksheet: worksheetInputSchema },
      required: ['worksheet'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: toolHandlers.checkReading,
  },
  {
    name: 'check_question_mix',
    title: 'Check question balance',
    description:
      'Tally multiple-choice, short-answer, and extended-response items against the live target ratio. Pass "current" to inspect the visible worksheet.',
    inputSchema: {
      type: 'object',
      properties: { worksheet: worksheetInputSchema },
      required: ['worksheet'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: toolHandlers.checkMix,
  },
  {
    name: 'check_standard_coverage',
    title: 'Check standards coverage',
    description:
      'Return which requested standards are hit or missing based on the standard tags attached to visible questions.',
    inputSchema: {
      type: 'object',
      properties: {
        worksheet: worksheetInputSchema,
        standards: { type: 'array', items: { type: 'string', maxLength: 80 }, minItems: 1, maxItems: 12 },
      },
      required: ['worksheet', 'standards'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: toolHandlers.checkCoverage,
  },
]

export function registerClassworkTools(
  onStatus?: (status: ToolStatus) => void,
) {
  const context = typeof document === 'undefined' ? undefined : document.modelContext
  if (!context?.registerTool) {
    onStatus?.({
      state: 'unsupported',
      count: 0,
      message: 'WebMCP tools become available in a supported in-app browser.',
    })
    return () => undefined
  }

  const lifecycle = new AbortController()
  onStatus?.({ state: 'checking', count: 0, message: 'Registering tools…' })
  let registered = 0

  for (const tool of tools) {
    try {
      void Promise.resolve(
        context.registerTool(tool, { signal: lifecycle.signal }),
      )
        .then(() => {
          registered += 1
          if (registered === tools.length) {
            onStatus?.({
              state: 'ready',
              count: tools.length,
              message: `${tools.length} WebMCP tools connected`,
            })
          }
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return
          console.error(`Failed to register ${tool.name}`, error)
          onStatus?.({
            state: 'error',
            count: registered,
            message: `${registered}/${tools.length} WebMCP tools connected`,
          })
        })
    } catch (error) {
      if (isAbortError(error)) continue
      console.error(`Failed to register ${tool.name}`, error)
      onStatus?.({
        state: 'error',
        count: registered,
        message: `${registered}/${tools.length} WebMCP tools connected`,
      })
    }
  }

  return () => lifecycle.abort()
}

export { checkTimeEstimate }
