import {
  DEFAULT_CONSTRAINTS,
  DEMO_SOURCE_TEXT,
  EMPTY_WORKSHEET,
  QUESTION_TYPE_LABELS,
  analyzeSourceMaterial,
  createDraftWorksheet,
  evaluateConstraints,
  assertQuestionContent,
  generateReplacementQuestion,
  normalizeQuestionChanges,
  type ActivityActor,
  type Question,
  type QuestionType,
  type SourceMaterial,
  type WorkspaceState,
  type WorksheetConstraints,
} from './worksheet'

const STORAGE_KEY = 'classwork.workspace.v1'

const initialState = (): WorkspaceState => ({
  version: 1,
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

function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorkspaceState>
  return (
    candidate.version === 1 &&
    Boolean(candidate.worksheet) &&
    Boolean(candidate.constraints) &&
    Array.isArray(candidate.activity)
  )
}

function readStoredState() {
  if (typeof window === 'undefined') return initialState()
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (!stored) return initialState()
    const parsed: unknown = JSON.parse(stored)
    if (!isWorkspaceState(parsed)) return initialState()
    return { ...parsed, lastError: typeof parsed.lastError === 'string' ? parsed.lastError : '' }
  } catch {
    return initialState()
  }
}

let state = readStoredState()
const listeners = new Set<() => void>()

const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

function persist(next: WorkspaceState) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch (error) {
    console.warn('Classwork could not persist this update.', error)
  }
}

function commit(updater: (current: WorkspaceState) => WorkspaceState) {
  state = updater(state)
  persist(state)
  listeners.forEach((listener) => listener())
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
  return imageOrText.startsWith('data:image/') || /^(?:https?:\/\/|\/).+\.(png|jpe?g|webp|gif|svg)(?:\?.*)?$/i.test(imageOrText)
    ? 'image'
    : 'text'
}

export const workspaceStore = {
  getSnapshot: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

export const workspaceActions = {
  addSourceMaterial(
    imageOrText: string,
    grade: number,
    topic: string,
    name = 'Classroom source',
    actor: ActivityActor = 'teacher',
    extractedText?: string,
  ) {
    if (grade !== 4) {
      throw new Error('Classwork is scoped to Grade 4 mathematics for this demo.')
    }
    const cleaned = imageOrText.trim()
    if (!cleaned) throw new Error('Source material cannot be empty.')
    const nextSource: SourceMaterial = {
      kind: sourceKind(cleaned),
      content: cleaned,
      extractedText: extractedText?.trim() || undefined,
      name: name.slice(0, 120),
      grade: 4,
      topic: topic.trim().slice(0, 100) || 'Fractions & decimals',
      addedAt: new Date().toISOString(),
    }
    commit((current) => ({
      ...current,
      source: nextSource,
      hasDraft: false,
      lastError: '',
      activity: withActivity(
        current,
        activity(actor, 'Added source material', `${nextSource.name} · Grade 4`),
      ),
    }))
    return nextSource
  },

  loadDemoSource() {
    return this.addSourceMaterial(
      '/sample-fractions-decimals.svg',
      4,
      'Fractions & decimals',
      'Fractions & decimals worksheet',
      'teacher',
      DEMO_SOURCE_TEXT,
    )
  },

  setConstraints(changes: Partial<WorksheetConstraints>) {
    commit((current) => ({
      ...current,
      constraints: {
        ...current.constraints,
        ...changes,
        questionMix: changes.questionMix
          ? { ...changes.questionMix }
          : current.constraints.questionMix,
        standards: changes.standards
          ? [...changes.standards]
          : current.constraints.standards,
      },
    }))
  },

  generateDraft(
    constraints?: Partial<WorksheetConstraints>,
    actor: ActivityActor = 'agent',
  ) {
    if (!state.source) {
      throw new Error('Add source material before generating a draft.')
    }
    const nextConstraints: WorksheetConstraints = {
      ...state.constraints,
      ...constraints,
      questionMix: constraints?.questionMix
        ? { ...constraints.questionMix }
        : state.constraints.questionMix,
      standards: constraints?.standards
        ? [...constraints.standards]
        : state.constraints.standards,
    }
    const sourceAnalysis = analyzeSourceMaterial(state.source)
    const worksheet = createDraftWorksheet(state.source.topic, state.source)
    try {
      worksheet.questions.forEach((question) => assertQuestionContent(question))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The draft could not be generated.'
      commit((current) => ({ ...current, lastError: message }))
      throw new Error(message)
    }
    commit((current) => ({
      ...current,
      constraints: nextConstraints,
      worksheet,
      hasDraft: true,
      lastError: '',
      lastAgentMessage:
        `Drafted six questions using ${sourceAnalysis.mode === 'topic-fallback' ? 'the selected topic' : 'the staged source evidence'}. Time and question balance still need attention.`,
      activity: withActivity(
        current,
        activity(
          actor,
          'Generated source-grounded draft',
          `${sourceAnalysis.focus.join(', ')} · 2 checks need attention`,
        ),
      ),
    }))
    return worksheet
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

  swapQuestion(id: string, reason: string, actor: ActivityActor = 'agent') {
    const currentQuestion = state.worksheet.questions.find(
      (question) => question.id === id,
    )
    if (!currentQuestion) throw new Error(`Question ${id} was not found.`)
    let replacement: Question
    try {
      replacement = assertQuestionContent(
        generateReplacementQuestion(currentQuestion, reason),
        reason,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The replacement could not be generated.'
      commit((current) => ({ ...current, lastError: message }))
      throw new Error(message)
    }
    const wantsDecimals = /decimal|hundredth|place value|compare/i.test(reason)

    commit((current) => {
      const index = current.worksheet.questions.findIndex(
        (question) => question.id === id,
      )
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
        lastAgentMessage: `Swapped Question ${index + 1} for a ${wantsDecimals ? 'decimal' : 'fraction'}-focused ${QUESTION_TYPE_LABELS[replacement.type].toLowerCase()} item.`,
        activity: withActivity(
          current,
          activity(
            actor,
            'Ran swap_question',
            `Question ${index + 1} · ${wantsDecimals ? 'fractions → decimals' : reason.slice(0, 70)}`,
          ),
        ),
      }
    })
    return replacement
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
    const questionContent: Record<QuestionType, Omit<Question, 'id' | 'type'>> = {
      'multiple-choice': {
        prompt: 'Which decimal is equal to 45/100?',
        options: ['0.045', '0.45', '4.5', '45.0'],
        standardIds: ['4.NF.C.6'],
      },
      'short-answer': {
        prompt: 'Compare 0.54 and 0.45 using >, <, or =. Explain your answer using place value.',
        standardIds: ['4.NF.C.7'],
      },
      'extended-response': {
        prompt: 'Use two models to show why 3/10 and 30/100 are equivalent. Then write both fractions as decimals.',
        standardIds: ['4.NF.C.5', '4.NF.C.6'],
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
    const next = initialState()
    state = next
    persist(next)
    listeners.forEach((listener) => listener())
  },
}

export function runAgentInstruction(instruction: string) {
  const cleaned = instruction.trim()
  if (!cleaned) throw new Error('Enter an instruction for the agent.')
  if (!state.hasDraft) throw new Error('Generate a draft before asking for revisions.')

  if (/swap|replace|change/i.test(cleaned)) {
    const fractionQuestion = state.worksheet.questions.find((question) =>
      /fraction|\/10|\/100|denominator/i.test(question.prompt),
    )
    const target = fractionQuestion ?? state.worksheet.questions[0]
    return workspaceActions.swapQuestion(target.id, cleaned, 'agent')
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
    'I can swap a question, shorten the worksheet, or add a multiple-choice item. Try “Swap the fractions question for something on decimals.”',
  )
  return null
}

export function currentConstraintSnapshot() {
  return evaluateConstraints(state.worksheet, state.constraints)
}
