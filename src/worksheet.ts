export type QuestionType =
  | 'multiple-choice'
  | 'short-answer'
  | 'extended-response'

export type ActivityActor = 'teacher' | 'agent' | 'system'

export interface Question {
  id: string
  type: QuestionType
  prompt: string
  options?: string[]
  standardIds: string[]
}

export interface Worksheet {
  title: string
  subtitle: string
  questions: Question[]
  updatedAt: string
}

export interface WorksheetConstraints {
  timeLimit: number
  readingLevel: number
  questionMix: Record<QuestionType, number>
  standards: string[]
}

export interface SourceMaterial {
  kind: 'image' | 'text'
  content: string
  name: string
  grade: 4
  topic: string
  addedAt: string
}

export interface ActivityItem {
  id: string
  actor: ActivityActor
  action: string
  detail: string
  createdAt: string
}

export interface WorkspaceState {
  version: 1
  source: SourceMaterial | null
  worksheet: Worksheet
  constraints: WorksheetConstraints
  hasDraft: boolean
  activity: ActivityItem[]
  lastAgentMessage: string
  lastError: string
}

export interface TimeCheck {
  estimate: number
  target: number
  lowerBound: number
  status: 'satisfied' | 'needs-attention'
}

export interface ReadingCheck {
  grade: number
  target: number
  range: [number, number]
  averageSentenceLength: number
  longWordRatio: number
  status: 'satisfied' | 'needs-attention'
}

export interface MixCheck {
  counts: Record<QuestionType, number>
  actual: Record<QuestionType, number>
  target: Record<QuestionType, number>
  status: 'satisfied' | 'needs-attention'
}

export interface CoverageCheck {
  hit: string[]
  missing: string[]
  total: number
  status: 'satisfied' | 'needs-attention'
}

export interface ConstraintSnapshot {
  time: TimeCheck
  reading: ReadingCheck
  mix: MixCheck
  coverage: CoverageCheck
  satisfiedCount: number
  total: 4
}

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  'multiple-choice': 'Multiple choice',
  'short-answer': 'Short answer',
  'extended-response': 'Extended response',
}

export const STANDARD_LIBRARY = [
  {
    id: '4.NF.C.5',
    short: 'Equivalent tenths & hundredths',
    description:
      'Express a fraction with denominator 10 as an equivalent fraction with denominator 100.',
  },
  {
    id: '4.NF.C.6',
    short: 'Decimal notation',
    description:
      'Use decimal notation for fractions with denominators 10 or 100.',
  },
  {
    id: '4.NF.C.7',
    short: 'Compare decimals',
    description:
      'Compare two decimals to hundredths by reasoning about their size.',
  },
] as const

export const DEFAULT_CONSTRAINTS: WorksheetConstraints = {
  timeLimit: 15,
  readingLevel: 4,
  questionMix: {
    'multiple-choice': 0.4,
    'short-answer': 0.4,
    'extended-response': 0.2,
  },
  standards: STANDARD_LIBRARY.map((standard) => standard.id),
}

// Ten percentage points is the declared tolerance for each response mode.
// Keep this as a ratio (0.10), matching `actual` and `target` below.
export const QUESTION_MIX_TOLERANCE = 0.1

export const DEMO_SOURCE_TEXT = `Grade 4 mathematics — fractions and decimals

• Review how tenths can be renamed as hundredths.
• Connect 3/10 to 30/100 and to decimal notation.
• Compare decimals to hundredths using >, <, and =.
• Ask students to explain one comparison with a model or place-value reasoning.
• Keep the independent practice to about 15 minutes.`

export const EMPTY_WORKSHEET: Worksheet = {
  title: 'Fractions as Decimals',
  subtitle: 'Grade 4 mathematics · Independent practice',
  questions: [],
  updatedAt: new Date(0).toISOString(),
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value))

const round = (value: number, places = 1) => {
  const multiplier = 10 ** places
  return Math.round(value * multiplier) / multiplier
}

const questionText = (question: Question) =>
  [question.prompt, ...(question.options ?? [])].join(' ')

export function createDraftQuestions(): Question[] {
  return [
    {
      id: 'q-equivalent-tenths',
      type: 'multiple-choice',
      prompt: 'Which fraction with a denominator of 100 is equivalent to 3/10?',
      options: ['3/100', '13/100', '30/100', '300/100'],
      standardIds: ['4.NF.C.5'],
    },
    {
      id: 'q-shaded-grid',
      type: 'short-answer',
      prompt:
        'Mina shaded 4/10 of a grid. Rewrite 4/10 with a denominator of 100 and explain how you know.',
      standardIds: ['4.NF.C.5', '4.NF.C.6'],
    },
    {
      id: 'q-between-decimals',
      type: 'multiple-choice',
      prompt: 'Which decimal is greater than 0.48 but less than 0.60?',
      options: ['0.40', '0.50', '0.68', '0.84'],
      standardIds: ['4.NF.C.7'],
    },
    {
      id: 'q-decimal-notation',
      type: 'short-answer',
      prompt:
        'Write 62/100 as a decimal. Then name the value of the digit in the hundredths place.',
      standardIds: ['4.NF.C.6'],
    },
    {
      id: 'q-race-times',
      type: 'extended-response',
      prompt:
        'Three students finished a short race in 0.64 minute, 0.60 minute, and 0.58 minute. Order the times from least to greatest and explain your comparison using place value.',
      standardIds: ['4.NF.C.7'],
    },
    {
      id: 'q-fraction-model',
      type: 'extended-response',
      prompt:
        'Draw two models to prove that 7/10 and 70/100 are equivalent fractions. Label each model and describe what stays the same.',
      standardIds: ['4.NF.C.5'],
    },
  ]
}

export function createDraftWorksheet(topic = 'Fractions & decimals'): Worksheet {
  return {
    title: 'Fractions as Decimals',
    subtitle: `Grade 4 mathematics · ${topic}`,
    questions: createDraftQuestions(),
    updatedAt: new Date().toISOString(),
  }
}

function instructionLeakPattern(text: string) {
  return /responds?\s+to\s+this\s+teacher\s+(note|instruction)|this\s+teacher\s+(note|instruction)\s*:/i.test(text) ||
    /^\s*(create|generate|make)\b.*\bquestion\b/i.test(text) ||
    /^\s*(swap|replace|change)\b/i.test(text)
}

/**
 * Validate generated content before it is allowed into the shared worksheet.
 * This specifically protects the board from prompt/instruction leakage.
 */
export function assertQuestionContent(question: Question, inputInstruction = '') {
  const prompt = question.prompt.trim()
  const normalizedPrompt = prompt.toLowerCase()
  const normalizedInstruction = inputInstruction.trim().toLowerCase()
  const invalidPrompt =
    !prompt ||
    (normalizedInstruction.length > 0 && normalizedPrompt === normalizedInstruction) ||
    instructionLeakPattern(prompt)
  const invalidOptions =
    question.type === 'multiple-choice' &&
    (!question.options || question.options.length < 2 || question.options.some((option) => !option.trim()))

  if (invalidPrompt || invalidOptions) {
    throw new Error(
      'The generated replacement was empty or still contained the teacher instruction. No changes were made.',
    )
  }
  return question
}

/**
 * A small, inspectable generation seam for the demo. The reason is input to
 * this function; only the generated question returned here may be committed.
 */
export function generateReplacementQuestion(question: Question, instruction: string): Question {
  const reason = instruction.trim()
  const wantsDecimals = /decimal|hundredth|place value|compare/i.test(reason)
  const wantsFractions = /fraction|tenths|equivalent|denominator/i.test(reason)

  if (wantsDecimals) {
    if (question.type === 'multiple-choice') {
      return {
        ...question,
        prompt: 'Which decimal has a 7 in the hundredths place?',
        options: ['0.07', '0.17', '0.70', '7.00'],
        standardIds: ['4.NF.C.6'],
      }
    }
    if (question.type === 'short-answer') {
      return {
        ...question,
        prompt:
          'Write a decimal greater than 0.43 and less than 0.50. Explain how the place values prove your answer.',
        options: undefined,
        standardIds: ['4.NF.C.7'],
      }
    }
    return {
      ...question,
      prompt:
        'Four measurements are 0.36 m, 0.63 m, 0.60 m, and 0.39 m. Order them from least to greatest and justify each comparison with place-value reasoning.',
      options: undefined,
      standardIds: ['4.NF.C.7'],
    }
  }

  if (wantsFractions) {
    if (question.type === 'multiple-choice') {
      return {
        ...question,
        prompt: 'Which fraction is equivalent to 6/10?',
        options: ['6/100', '16/100', '60/100', '600/100'],
        standardIds: ['4.NF.C.5'],
      }
    }
    return {
      ...question,
      prompt:
        'Show how 8/10 can be renamed with a denominator of 100. Explain the multiplication you used.',
      options: undefined,
      standardIds: ['4.NF.C.5'],
    }
  }

  throw new Error(
    'I could not generate a replacement from that note. Name the target concept, such as decimals or fractions, and try again.',
  )
}

export function checkTimeEstimate(worksheet: Pick<Worksheet, 'questions'>): TimeCheck {
  const baseMinutes: Record<QuestionType, number> = {
    'multiple-choice': 1.4,
    'short-answer': 2.2,
    'extended-response': 3.8,
  }
  const responseTime = worksheet.questions.reduce(
    (sum, question) => sum + baseMinutes[question.type],
    0,
  )
  const readingWords = worksheet.questions
    .map(questionText)
    .join(' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
  const estimate = round(responseTime + readingWords / 170)

  return {
    estimate,
    target: DEFAULT_CONSTRAINTS.timeLimit,
    lowerBound: round(DEFAULT_CONSTRAINTS.timeLimit * 0.7),
    status: 'needs-attention',
  }
}

export function checkReadingLevel(
  worksheet: Pick<Worksheet, 'questions'>,
): ReadingCheck {
  const text = worksheet.questions.map(questionText).join(' ').trim()
  const words = text.match(/[A-Za-z0-9/]+/g) ?? []
  const sentenceCount = Math.max(1, text.split(/[.!?]+/).filter(Boolean).length)
  const averageSentenceLength = words.length / sentenceCount
  const longWords = words.filter(
    (word) => word.replace(/[^A-Za-z]/g, '').length >= 8,
  ).length
  const longWordRatio = words.length ? longWords / words.length : 0
  const grade = words.length
    ? round(2.05 + averageSentenceLength * 0.18 + longWordRatio * 4.8)
    : 0

  return {
    grade,
    target: DEFAULT_CONSTRAINTS.readingLevel,
    range: [3.3, 4.7],
    averageSentenceLength: round(averageSentenceLength),
    longWordRatio: round(longWordRatio, 2),
    status: 'needs-attention',
  }
}

export function checkQuestionMix(
  worksheet: Pick<Worksheet, 'questions'>,
  target: WorksheetConstraints['questionMix'] = DEFAULT_CONSTRAINTS.questionMix,
): MixCheck {
  const counts: Record<QuestionType, number> = {
    'multiple-choice': 0,
    'short-answer': 0,
    'extended-response': 0,
  }
  worksheet.questions.forEach((question) => {
    counts[question.type] += 1
  })
  const total = worksheet.questions.length
  const actual: Record<QuestionType, number> = {
    'multiple-choice': total ? counts['multiple-choice'] / total : 0,
    'short-answer': total ? counts['short-answer'] / total : 0,
    'extended-response': total ? counts['extended-response'] / total : 0,
  }
  const withinTolerance = total > 0 && (Object.keys(target) as QuestionType[]).every(
    (type) => Math.abs(actual[type] - target[type]) <= QUESTION_MIX_TOLERANCE,
  )

  return {
    counts,
    actual,
    target,
    status: withinTolerance ? 'satisfied' : 'needs-attention',
  }
}

export function checkStandardCoverage(
  worksheet: Pick<Worksheet, 'questions'>,
  standards: string[],
): CoverageCheck {
  const tagged = new Set(
    worksheet.questions.flatMap((question) => question.standardIds),
  )
  const hit = standards.filter((standard) => tagged.has(standard))
  const missing = standards.filter((standard) => !tagged.has(standard))
  return {
    hit,
    missing,
    total: standards.length,
    status:
      standards.length > 0 && missing.length === 0
        ? 'satisfied'
        : 'needs-attention',
  }
}

export function evaluateConstraints(
  worksheet: Pick<Worksheet, 'questions'>,
  constraints: WorksheetConstraints,
): ConstraintSnapshot {
  const rawTime = checkTimeEstimate(worksheet)
  const lowerBound = round(constraints.timeLimit * 0.7)
  const time: TimeCheck = {
    ...rawTime,
    target: constraints.timeLimit,
    lowerBound,
    status:
      rawTime.estimate >= lowerBound &&
      rawTime.estimate <= constraints.timeLimit
        ? 'satisfied'
        : 'needs-attention',
  }

  const rawReading = checkReadingLevel(worksheet)
  const readingRange: [number, number] = [
    round(constraints.readingLevel - 0.7),
    round(constraints.readingLevel + 0.7),
  ]
  const reading: ReadingCheck = {
    ...rawReading,
    target: constraints.readingLevel,
    range: readingRange,
    status:
      rawReading.grade >= readingRange[0] && rawReading.grade <= readingRange[1]
        ? 'satisfied'
        : 'needs-attention',
  }

  const mix = checkQuestionMix(worksheet, constraints.questionMix)
  const coverage = checkStandardCoverage(worksheet, constraints.standards)
  const checks = [time, reading, mix, coverage]

  return {
    time,
    reading,
    mix,
    coverage,
    satisfiedCount: checks.filter((check) => check.status === 'satisfied').length,
    total: 4,
  }
}

export function normalizeQuestionChanges(
  changes: Partial<Pick<Question, 'prompt' | 'type' | 'options' | 'standardIds'>>,
) {
  const normalized: Partial<Question> = {}
  if (typeof changes.prompt === 'string') {
    const prompt = changes.prompt.trimStart().slice(0, 900)
    if (instructionLeakPattern(prompt)) {
      throw new Error(
        'That wording looks like an agent instruction, not a student-facing question. No changes were made.',
      )
    }
    normalized.prompt = prompt
  }
  if (
    changes.type &&
    ['multiple-choice', 'short-answer', 'extended-response'].includes(changes.type)
  ) {
    normalized.type = changes.type
  }
  if (Array.isArray(changes.options)) {
    normalized.options = changes.options
      .filter((option): option is string => typeof option === 'string')
      .slice(0, 6)
      .map((option) => option.slice(0, 120))
  }
  if (Array.isArray(changes.standardIds)) {
    normalized.standardIds = changes.standardIds.filter((id) =>
      STANDARD_LIBRARY.some((standard) => standard.id === id),
    )
  }
  return normalized
}

export const toPercent = (value: number) =>
  `${Math.round(clamp(value, 0, 1) * 100)}%`
