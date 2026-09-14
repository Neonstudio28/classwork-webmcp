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

export interface ClassProfile {
  grade: number
  subject: string
  topic: string
}

export interface SourceMaterial {
  kind: 'image' | 'text'
  content: string
  extractedText?: string
  name: string
  grade: number
  subject: string
  topic: string
  addedAt: string
}

export interface SourceAnalysis {
  mode: 'source-text' | 'image-transcript' | 'topic-fallback'
  focus: string[]
  tenthsNumerator: number
  decimals: string[]
  fractions: Array<{ numerator: number; denominator: number }>
  fractionComparison?: {
    left: { numerator: number; denominator: number }
    right: { numerator: number; denominator: number }
    commonDenominator: number
    leftEquivalentNumerator: number
    rightEquivalentNumerator: number
    relation: '>' | '<' | '='
  }
}

export interface ActivityItem {
  id: string
  actor: ActivityActor
  action: string
  detail: string
  createdAt: string
}

export interface WorkspaceState {
  version: 2
  modifiedAt: string
  profile: ClassProfile
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
    id: '4.NF.A.2',
    short: 'Compare fractions',
    description:
      'Compare two fractions with different numerators and denominators using common benchmarks or denominators.',
  },
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

export const DEFAULT_PROFILE: ClassProfile = {
  grade: 4,
  subject: '',
  topic: '',
}

export const DEFAULT_CONSTRAINTS: WorksheetConstraints = {
  timeLimit: 15,
  readingLevel: 4,
  questionMix: {
    'multiple-choice': 0.4,
    'short-answer': 0.4,
    'extended-response': 0.2,
  },
  standards: [],
}

// Ten percentage points is the declared tolerance for each response mode.
// Keep this as a ratio (0.10), matching `actual` and `target` below.
export const QUESTION_MIX_TOLERANCE = 0.1

export const EMPTY_WORKSHEET: Worksheet = {
  title: '',
  subtitle: '',
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

export function analyzeSourceMaterial(
  source: Pick<SourceMaterial, 'kind' | 'content' | 'extractedText' | 'topic'>,
): SourceAnalysis {
  const sourceText =
    source.kind === 'text'
      ? source.content
      : source.extractedText?.trim() || source.topic
  const mode: SourceAnalysis['mode'] =
    source.kind === 'text'
      ? 'source-text'
      : source.extractedText?.trim()
        ? 'image-transcript'
        : 'topic-fallback'
  const focus: string[] = []
  const fractions = Array.from(
    sourceText.matchAll(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b/g),
    (match) => ({
      numerator: Number(match[1]),
      denominator: Number(match[2]),
    }),
  ).filter(
    (fraction) =>
      fraction.denominator > 0 &&
      fraction.denominator <= 100 &&
      fraction.numerator >= 0 &&
      fraction.numerator <= 100,
  )
  const comparisonIntent =
    /common denominators?/i.test(sourceText) ||
    /compare\s+(?:the\s+)?\d{1,3}\s*\/\s*\d{1,3}[^.!?\n]{0,80}\d{1,3}\s*\/\s*\d{1,3}/i.test(sourceText) ||
    /which\s+fraction\s+is\s+(?:greater|less)/i.test(sourceText)
  const [left, right] = fractions
  const greatestCommonDivisor = (first: number, second: number): number =>
    second === 0 ? Math.abs(first) : greatestCommonDivisor(second, first % second)
  const fractionComparison = comparisonIntent && left && right
    ? (() => {
        const divisor = greatestCommonDivisor(left.denominator, right.denominator)
        const commonDenominator = (left.denominator * right.denominator) / divisor
        if (commonDenominator > 300) return undefined
        const leftEquivalentNumerator = left.numerator * (commonDenominator / left.denominator)
        const rightEquivalentNumerator = right.numerator * (commonDenominator / right.denominator)
        const relation = leftEquivalentNumerator === rightEquivalentNumerator
          ? '=' as const
          : leftEquivalentNumerator > rightEquivalentNumerator
            ? '>' as const
            : '<' as const
        return {
          left,
          right,
          commonDenominator,
          leftEquivalentNumerator,
          rightEquivalentNumerator,
          relation,
        }
      })()
    : undefined

  if (fractionComparison) {
    focus.push('comparing fractions with unlike denominators')
  } else if (/equivalent|denominator|tenths?|hundredths?|\/[\s]*(?:10|100)\b/i.test(sourceText)) {
    focus.push('equivalent tenths & hundredths')
  }
  if (/decimal|notation|\b0\.\d{1,2}\b/i.test(sourceText)) {
    focus.push('decimal notation')
  }
  if (!fractionComparison && /compare|greater|less|place[ -]?value|[><=]/i.test(sourceText)) {
    focus.push('decimal comparison')
  }
  if (!focus.length) focus.push(source.topic.trim() || 'source material')

  const tenthsMatch = sourceText.match(/\b([1-9])\s*\/\s*10\b/)
  const decimals = Array.from(
    new Set(sourceText.match(/\b0\.\d{1,2}\b/g) ?? []),
  ).slice(0, 4)

  return {
    mode,
    focus,
    tenthsNumerator: tenthsMatch ? Number(tenthsMatch[1]) : 3,
    decimals,
    fractions,
    fractionComparison,
  }
}

export function sourceGroundingLabel(analysis: SourceAnalysis) {
  const hasRecognizedExamples = Boolean(
    analysis.fractionComparison || analysis.fractions.length || analysis.decimals.length,
  )
  if (analysis.mode === 'source-text') {
    return hasRecognizedExamples
      ? 'Pasted examples ground this draft'
      : 'Pasted source grounds this draft'
  }
  if (analysis.mode === 'image-transcript') {
    return hasRecognizedExamples
      ? 'Image transcript grounds this draft'
      : 'Image transcript grounds this draft'
  }
  return 'Topic-guided fallback · no local image OCR'
}

export function hasSourceEvidence(analysis: SourceAnalysis) {
  return analysis.mode !== 'topic-fallback'
}

function createFractionComparisonQuestions(
  comparison: NonNullable<SourceAnalysis['fractionComparison']>,
): Question[] {
  const left = `${comparison.left.numerator}/${comparison.left.denominator}`
  const right = `${comparison.right.numerator}/${comparison.right.denominator}`
  const leftEquivalent = `${comparison.leftEquivalentNumerator}/${comparison.commonDenominator}`
  const rightEquivalent = `${comparison.rightEquivalentNumerator}/${comparison.commonDenominator}`
  const correctComparison = `${left} ${comparison.relation} ${right}`

  return [
    {
      id: 'q-compare-fractions',
      type: 'multiple-choice',
      prompt: `Which comparison between ${left} and ${right} is true?`,
      options: [
        correctComparison,
        `${left} ${comparison.relation === '>' ? '<' : '>'} ${right}`,
        `${left} = ${right}`,
        'Not enough information',
      ],
      standardIds: ['4.NF.A.2'],
    },
    {
      id: 'q-common-denominator',
      type: 'short-answer',
      prompt: `Rewrite ${left} and ${right} using the common denominator ${comparison.commonDenominator}. Show how each numerator changes.`,
      standardIds: ['4.NF.A.2'],
    },
    {
      id: 'q-equivalent-pair',
      type: 'multiple-choice',
      prompt: `Which pair correctly renames ${left} and ${right} with the same denominator?`,
      options: [
        `${leftEquivalent} and ${rightEquivalent}`,
        `${comparison.left.numerator}/${comparison.commonDenominator} and ${comparison.right.numerator}/${comparison.commonDenominator}`,
        `${comparison.leftEquivalentNumerator + 1}/${comparison.commonDenominator} and ${rightEquivalent}`,
        `${leftEquivalent} and ${comparison.rightEquivalentNumerator + 1}/${comparison.commonDenominator}`,
      ],
      standardIds: ['4.NF.A.2'],
    },
    {
      id: 'q-explain-comparison',
      type: 'short-answer',
      prompt: `Explain how ${leftEquivalent} and ${rightEquivalent} prove that ${correctComparison}.`,
      standardIds: ['4.NF.A.2'],
    },
    {
      id: 'q-model-comparison',
      type: 'extended-response',
      prompt: `Draw equal-size models or a number line for ${left} and ${right}. Label both fractions and use the model to justify ${correctComparison}.`,
      standardIds: ['4.NF.A.2'],
    },
    {
      id: 'q-correct-misconception',
      type: 'extended-response',
      prompt: `A student compares only the numerators in ${left} and ${right}. Explain why that strategy is unreliable, then use the common denominator ${comparison.commonDenominator} to prove the correct comparison.`,
      standardIds: ['4.NF.A.2'],
    },
  ]
}

export function createDraftQuestions(
  analysis: SourceAnalysis = {
    mode: 'topic-fallback',
    focus: ['fractions & decimals'],
    tenthsNumerator: 3,
    decimals: [],
    fractions: [],
  },
): Question[] {
  if (analysis.fractionComparison) {
    return createFractionComparisonQuestions(analysis.fractionComparison)
  }

  const tenthsFraction = `${analysis.tenthsNumerator}/10`
  const equivalentHundredths = `${analysis.tenthsNumerator * 10}/100`
  const sourceHundredths = analysis.fractions.find(
    (fraction) => fraction.denominator === 100,
  )
  const hundredthsFraction = sourceHundredths
    ? `${sourceHundredths.numerator}/100`
    : equivalentHundredths
  const hundredthsDecimal = sourceHundredths
    ? (sourceHundredths.numerator / 100).toFixed(2)
    : (analysis.tenthsNumerator / 10).toFixed(1)
  const raceDecimals = analysis.decimals.length >= 3
    ? analysis.decimals.slice(0, 3)
    : analysis.decimals.length === 2
      ? [...analysis.decimals, (Math.max(0, Number(analysis.decimals[0]) - 0.05)).toFixed(2)]
      : analysis.decimals.length === 1
        ? [
            analysis.decimals[0],
            (Math.max(0, Number(analysis.decimals[0]) - 0.05)).toFixed(2),
            (Math.min(0.99, Number(analysis.decimals[0]) + 0.04)).toFixed(2),
          ]
        : ['0.64', '0.60', '0.58']
  const comparisonQuestion = analysis.decimals.length >= 2
    ? {
        prompt: `Which symbol makes ${analysis.decimals[0]} __ ${analysis.decimals[1]} true?`,
        options: ['>', '<', '=', 'Not enough information'],
      }
    : {
        prompt: 'Which decimal is greater than 0.48 but less than 0.60?',
        options: ['0.40', '0.50', '0.68', '0.84'],
      }

  return [
    {
      id: 'q-equivalent-tenths',
      type: 'multiple-choice',
      prompt: `Which fraction with a denominator of 100 is equivalent to ${tenthsFraction}?`,
      options: [
        `${analysis.tenthsNumerator}/100`,
        `${analysis.tenthsNumerator + 10}/100`,
        equivalentHundredths,
        `${analysis.tenthsNumerator * 100}/100`,
      ],
      standardIds: ['4.NF.C.5'],
    },
    {
      id: 'q-shaded-grid',
      type: 'short-answer',
      prompt: `Mina shaded ${tenthsFraction} of a grid. Rewrite ${tenthsFraction} with a denominator of 100 and explain how you know.`,
      standardIds: ['4.NF.C.5', '4.NF.C.6'],
    },
    {
      id: 'q-between-decimals',
      type: 'multiple-choice',
      prompt: comparisonQuestion.prompt,
      options: comparisonQuestion.options,
      standardIds: ['4.NF.C.7'],
    },
    {
      id: 'q-decimal-notation',
      type: 'short-answer',
      prompt: `Write ${hundredthsFraction} as a decimal. Then explain what the last digit in ${hundredthsDecimal} represents.`,
      standardIds: ['4.NF.C.6'],
    },
    {
      id: 'q-race-times',
      type: 'extended-response',
      prompt: `Three students recorded ${raceDecimals[0]}, ${raceDecimals[1]}, and ${raceDecimals[2]}. Order the values from least to greatest and explain your comparison using place value.`,
      standardIds: ['4.NF.C.7'],
    },
    {
      id: 'q-fraction-model',
      type: 'extended-response',
      prompt: `Draw two models to prove that ${tenthsFraction} and ${equivalentHundredths} are equivalent fractions. Label each model and describe what stays the same.`,
      standardIds: ['4.NF.C.5'],
    },
  ]
}

function cleanSourceSentences(sourceText: string) {
  return Array.from(new Set(
    sourceText
      .replace(/[•\r]/g, ' ')
      .split(/(?<=[.!?])\s+|\n+/)
      .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
      .filter((sentence) => sentence.length >= 12),
  )).slice(0, 6)
}

function truncateEvidence(value: string, maximum = 150) {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1).trim()}…`
}

function createSourceGroundedQuestions(
  sourceText: string,
  profile: ClassProfile,
  standards: string[],
): Question[] {
  const topic = profile.topic.trim() || 'the lesson topic'
  const sentences = cleanSourceSentences(sourceText)
  const evidence = (index: number) => truncateEvidence(
    sentences[index % Math.max(1, sentences.length)] || sourceText.trim() || topic,
  )
  const tags = (index: number) => standards.length
    ? [standards[index % standards.length]]
    : []

  return [
    {
      id: 'q-source-idea',
      type: 'multiple-choice',
      prompt: `Which statement is directly supported by the source about ${topic}?`,
      options: [
        evidence(0),
        `The source says ${topic} has no important details.`,
        `Every example of ${topic} has exactly the same meaning.`,
        `The source does not discuss ${topic}.`,
      ],
      standardIds: tags(0),
    },
    {
      id: 'q-explain-source',
      type: 'short-answer',
      prompt: `Explain this source idea in your own words: “${evidence(1)}”`,
      standardIds: tags(1),
    },
    {
      id: 'q-summary-detail',
      type: 'multiple-choice',
      prompt: `Which detail belongs in an accurate summary of ${topic}?`,
      options: [
        evidence(2),
        `A detail unrelated to ${topic}.`,
        `An opinion that is not supported by the source.`,
        `A claim that contradicts the class material.`,
      ],
      standardIds: tags(2),
    },
    {
      id: 'q-use-evidence',
      type: 'short-answer',
      prompt: `Use one detail from the source to explain an important idea about ${topic}.`,
      standardIds: tags(3),
    },
    {
      id: 'q-apply-learning',
      type: 'extended-response',
      prompt: `Create a new example that applies what the source teaches about ${topic}. Explain how your example connects to the class material.`,
      standardIds: tags(4),
    },
    {
      id: 'q-synthesize-source',
      type: 'extended-response',
      prompt: `What are the two most important ideas a student should remember about ${topic}? Support both ideas with evidence from the source.`,
      standardIds: tags(5),
    },
  ]
}

export function createDraftWorksheet(
  profile: ClassProfile,
  source?: Pick<SourceMaterial, 'kind' | 'content' | 'extractedText' | 'topic'>,
  standards: string[] = [],
): Worksheet {
  const analysis = source
    ? analyzeSourceMaterial(source)
    : {
        mode: 'topic-fallback' as const,
        focus: ['fractions & decimals'],
        tenthsNumerator: 3,
        decimals: [],
        fractions: [],
      }
  const sourceText = source
    ? source.kind === 'text'
      ? source.content
      : source.extractedText?.trim() || ''
    : ''
  const isGradeFourMath = profile.grade === 4 && /math/i.test(profile.subject)
  const useMathGenerator = isGradeFourMath && Boolean(
    analysis.fractionComparison || analysis.fractions.length || analysis.decimals.length,
  )
  const questions = useMathGenerator
    ? createDraftQuestions(analysis).map((question, index) => ({
        ...question,
        standardIds: standards.length
          ? question.standardIds.filter((id) => standards.includes(id)).length
            ? question.standardIds.filter((id) => standards.includes(id))
            : [standards[index % standards.length]]
          : [],
      }))
    : createSourceGroundedQuestions(sourceText, profile, standards)
  return {
    title: analysis.fractionComparison
      ? 'Comparing Fractions'
      : `${profile.topic.trim() || 'Source-Based'} Practice`,
    subtitle: `Grade ${profile.grade} ${profile.subject.trim()} · ${profile.topic.trim()} · Source-grounded`,
    questions,
    updatedAt: new Date().toISOString(),
  }
}

function instructionLeakPattern(text: string) {
  return /responds?\s+to\s+this\s+teacher\s+(note|instruction)|this\s+teacher\s+(note|instruction)\s*:/i.test(text) ||
    /^\s*(create|generate|make)\b.*\bquestions?\b/i.test(text) ||
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
    (normalizedInstruction.length > 0 && normalizedPrompt.includes(normalizedInstruction)) ||
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

  const concept = reason
    .replace(
      /^(?:please\s+)?(?:swap|replace|change)(?:\s+(?:this|the)(?:\s+question)?)?\s+(?:for|with|into|to)\s+(?:a|an)?\s*(?:new\s+)?(?:question|item)?\s*(?:about|on|covering)?\s*/i,
      '',
    )
    .replace(
      /^(?:create|generate|make)\s+(?:a|an)?\s*(?:new\s+)?(?:question|item)?\s*(?:about|on|covering)?\s*/i,
      '',
    )
    .trim()
  if (!concept) {
    throw new Error('Name the concept the replacement question should assess.')
  }
  if (question.type === 'multiple-choice') {
    return {
      ...question,
      prompt: `Which statement best explains ${concept}?`,
      options: [
        `A clear explanation of ${concept} using the source material`,
        `A statement about an unrelated topic`,
        `An unsupported claim about ${concept}`,
        `A detail that contradicts the source material`,
      ],
    }
  }
  return {
    ...question,
    prompt: `Use evidence from the class material to explain ${concept}.`,
    options: undefined,
  }
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
    normalized.standardIds = changes.standardIds
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 8)
  }
  return normalized
}

export const toPercent = (value: number) =>
  `${Math.round(clamp(value, 0, 1) * 100)}%`
