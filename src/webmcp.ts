import {
  checkQuestionMix,
  checkReadingLevel,
  checkStandardCoverage,
  checkTimeEstimate,
  evaluateConstraints,
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
  | { state: 'ready'; count: 8; message: string }
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
    id: { type: 'string' },
    type: {
      type: 'string',
      enum: ['multiple-choice', 'short-answer', 'extended-response'],
    },
    prompt: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    standardIds: { type: 'array', items: { type: 'string' } },
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
        questions: { type: 'array', items: questionSchema },
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

function resolveWorksheet(value: unknown): Pick<Worksheet, 'questions'> {
  if (value === 'current') return workspaceStore.getSnapshot().worksheet
  const record = asRecord(value)
  if (!Array.isArray(record.questions)) {
    throw new Error('worksheet.questions must be an array.')
  }
  return { questions: record.questions as Question[] }
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
    const imageOrText = asNonEmptyString(record.image_or_text, 'image_or_text')
    const grade = Number(record.grade)
    const topic = asNonEmptyString(record.topic, 'topic')
    const source = workspaceActions.addSourceMaterial(
      imageOrText,
      grade,
      topic,
      'Added by classroom agent',
      'agent',
    )
    return {
      source: { kind: source.kind, grade: source.grade, topic: source.topic },
      visibleState: conciseState(),
    }
  },

  generateDraft(input: unknown) {
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
      standards: Array.isArray(rawConstraints.standards)
        ? rawConstraints.standards.map(String)
        : [],
    }
    if (!Number.isFinite(constraints.timeLimit) || constraints.timeLimit! <= 0) {
      throw new Error('time_limit must be a positive number.')
    }
    if (!Number.isFinite(constraints.readingLevel)) {
      throw new Error('reading_level must be a number.')
    }
    const worksheet = workspaceActions.generateDraft(constraints, 'agent')
    return {
      worksheet: { title: worksheet.title, questionCount: worksheet.questions.length },
      visibleState: conciseState(),
    }
  },

  editQuestion(input: unknown) {
    const record = asRecord(input)
    const id = asNonEmptyString(record.id, 'id')
    const changes = asRecord(record.changes) as Partial<
      Pick<Question, 'prompt' | 'type' | 'options' | 'standardIds'>
    >
    const question = workspaceActions.editQuestion(id, changes, 'agent', true)
    return { question, visibleState: conciseState() }
  },

  swapQuestion(input: unknown) {
    const record = asRecord(input)
    const id = asNonEmptyString(record.id, 'id')
    const reason = asNonEmptyString(record.reason, 'reason')
    const question = workspaceActions.swapQuestion(id, reason, 'agent')
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
    if (!Array.isArray(record.standards)) {
      throw new Error('standards must be an array of standard identifiers.')
    }
    return checkStandardCoverage(worksheet, record.standards.map(String))
  },
}

const tools: WebMcpTool[] = [
  {
    name: 'add_source_material',
    title: 'Add source material',
    description:
      'Stage a photo data URL, image URL, or pasted classroom text as the source for the visible Grade 4 mathematics worksheet. This changes the source panel but does not generate questions.',
    inputSchema: {
      type: 'object',
      properties: {
        image_or_text: {
          type: 'string',
          description: 'Image data URL, image URL, or the source text to use.',
        },
        grade: { type: 'integer', const: 4 },
        topic: { type: 'string' },
      },
      required: ['image_or_text', 'grade', 'topic'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: toolHandlers.addSourceMaterial,
  },
  {
    name: 'generate_draft',
    title: 'Generate worksheet draft',
    description:
      'Create and display a Grade 4 fractions-and-decimals worksheet from the staged source using explicit time, reading, mix, and standards constraints.',
    inputSchema: {
      type: 'object',
      properties: {
        constraints: {
          type: 'object',
          properties: {
            time_limit: { type: 'number', minimum: 5, maximum: 45 },
            reading_level: { type: 'number', minimum: 3, maximum: 5 },
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
            standards: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
          required: ['time_limit', 'reading_level', 'question_mix', 'standards'],
          additionalProperties: false,
        },
      },
      required: ['constraints'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
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
        id: { type: 'string' },
        changes: {
          type: 'object',
          properties: {
            prompt: { type: 'string', maxLength: 900 },
            type: {
              type: 'string',
              enum: ['multiple-choice', 'short-answer', 'extended-response'],
            },
            options: { type: 'array', items: { type: 'string' }, maxItems: 6 },
            standardIds: { type: 'array', items: { type: 'string' } },
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
      'Replace one visible question while preserving its position and question type. The reason guides the replacement; use this for teacher requests such as swapping a fractions item for a decimals item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        reason: { type: 'string', minLength: 1, maxLength: 400 },
      },
      required: ['id', 'reason'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: toolHandlers.swapQuestion,
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
        standards: { type: 'array', items: { type: 'string' }, minItems: 1 },
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
              count: 8,
              message: '8 WebMCP tools connected',
            })
          }
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return
          console.error(`Failed to register ${tool.name}`, error)
          onStatus?.({
            state: 'error',
            count: registered,
            message: `${registered}/8 WebMCP tools connected`,
          })
        })
    } catch (error) {
      if (isAbortError(error)) continue
      console.error(`Failed to register ${tool.name}`, error)
      onStatus?.({
        state: 'error',
        count: registered,
        message: `${registered}/8 WebMCP tools connected`,
      })
    }
  }

  return () => lifecycle.abort()
}

export { checkTimeEstimate }
