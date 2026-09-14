import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerClassworkTools, toolHandlers } from './webmcp.ts'
import { workspaceActions, workspaceStore } from './workspaceStore.ts'

const originalFetch = globalThis.fetch
const originalDocument = globalThis.document

function rejectNetwork() {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed')
  }
}

function stubDocument() {
  const registered: Array<{ name: string; signal?: AbortSignal }> = []
  globalThis.document = {
    modelContext: {
      registerTool: (
        tool: { name: string },
        options?: { signal?: AbortSignal },
      ) => {
        registered.push({ name: tool.name, signal: options?.signal })
      },
    },
  } as unknown as Document
  return registered
}

beforeEach(() => {
  rejectNetwork()
  workspaceActions.reset()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalThis, 'document')
  }
})

describe('registerClassworkTools', () => {
  it('reports unsupported browsers and returns a no-op cleanup', () => {
    const statuses: string[] = []
    const dispose = registerClassworkTools((status) => statuses.push(status.state))
    assert.deepEqual(statuses, ['unsupported'])
    assert.equal(typeof dispose, 'function')
  })

  it('registers all nine tools and aborts them on cleanup', async () => {
    const registered = stubDocument()
    const statuses: string[] = []
    const dispose = registerClassworkTools((status) => statuses.push(status.state))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(registered.length, 9)
    const names = new Set(registered.map((item) => item.name))
    for (const expected of [
      'add_source_material',
      'generate_draft',
      'edit_question',
      'swap_question',
      'read_workspace_state',
      'check_standard_coverage',
    ]) {
      assert.ok(names.has(expected), expected)
    }
    assert.deepEqual(statuses, ['checking', 'ready'])
    dispose()
    assert.ok(registered.every((item) => item.signal?.aborted))
  })

  it('reports an error when registration fails', async () => {
    globalThis.document = {
      modelContext: {
        registerTool: () => {
          throw new Error('registration failed')
        },
      },
    } as unknown as Document
    const statuses: string[] = []
    registerClassworkTools((status) => statuses.push(status.state))
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(statuses.includes('error'))
  })
})

describe('toolHandlers.readWorkspaceState', () => {
  it('describes an empty workspace', () => {
    const state = toolHandlers.readWorkspaceState()
    assert.equal(state.source, null)
    assert.equal(state.hasDraft, false)
    assert.equal(state.checks.satisfiedCount, 0)
    assert.equal(state.checks.total, 4)
    assert.equal(state.worksheet.questions.length, 0)
    assert.equal(state.profile.grade, 4)
  })

  it('exposes source text and grounding after staging', () => {
    workspaceActions.addSourceMaterial('Plants use sunlight to make food.', 4, 'Science', 'Plants')
    const state = toolHandlers.readWorkspaceState()
    assert.equal(state.source?.sourceText, 'Plants use sunlight to make food.')
    assert.equal(state.source?.grounding, 'Pasted source grounds this draft')
  })
})

describe('toolHandlers.addSourceMaterial', () => {
  it('stages source from the agent and returns a summary', () => {
    const result = toolHandlers.addSourceMaterial({
      image_or_text: 'Notes about fractions.',
      grade: 4,
      subject: 'Math',
      topic: 'Tenths',
    })
    assert.equal(result.source.kind, 'text')
    assert.equal(result.source.subject, 'Math')
    assert.equal(result.visibleState.questionCount, 0)
    assert.equal(workspaceStore.getSnapshot().activity[0].actor, 'agent')
  })

  it('rejects remote URLs, bad grades, and missing fields', () => {
    assert.throws(
      () => toolHandlers.addSourceMaterial({ image_or_text: 'https://x.example/a.png', grade: 4, subject: 'M', topic: 'T' }),
      /Remote image URLs/,
    )
    assert.throws(
      () => toolHandlers.addSourceMaterial({ image_or_text: 'legit text', grade: 'abc', subject: 'M', topic: 'T' }),
      /whole number from 1 to 12/,
    )
    assert.throws(
      () => toolHandlers.addSourceMaterial({ grade: 4, subject: 'M', topic: 'T' }),
      /image_or_text must be a non-empty string/,
    )
  })
})

describe('toolHandlers.generateDraft', () => {
  const validConstraints = {
    time_limit: 15,
    reading_level: 4,
    question_mix: {
      'multiple-choice': 0.4,
      'short-answer': 0.4,
      'extended-response': 0.2,
    },
    standards: ['4.NF.C.6'],
  }

  it('validates constraints before touching the store', async () => {
    await assert.rejects(() => toolHandlers.generateDraft('nope'), /Expected an object input/)
    await assert.rejects(
      () => toolHandlers.generateDraft({ constraints: { ...validConstraints, time_limit: 3 } }),
      /time_limit must be between 5 and 45/,
    )
    await assert.rejects(
      () => toolHandlers.generateDraft({
        constraints: {
          ...validConstraints,
          question_mix: { 'multiple-choice': 1, 'short-answer': 1, 'extended-response': 0 },
        },
      }),
      /question_mix values/,
    )
    await assert.rejects(
      () => toolHandlers.generateDraft({ constraints: { ...validConstraints, standards: [] } }),
      /standards must contain between 1 and 12 identifiers/,
    )
  })

  it('generates a six-question draft through the local fallback', async () => {
    toolHandlers.addSourceMaterial({ image_or_text: 'Notes about fractions.', grade: 4, subject: 'Math', topic: 'Tenths' })
    const result = await toolHandlers.generateDraft({ constraints: validConstraints })
    assert.equal(result.worksheet.questionCount, 6)
    assert.equal(result.visibleState.questionCount, 6)
    assert.match(workspaceStore.getSnapshot().lastAgentMessage, /local fallback/)
  })
})

describe('toolHandlers.editQuestion', () => {
  it('rejects unknown keys, invalid types, and empty changes', () => {
    const added = workspaceActions.addQuestion('short-answer')
    assert.throws(
      () => toolHandlers.editQuestion({ id: added.id, changes: { prompt: 'x', frobnicate: true } }),
      /only prompt, type, options, or standardIds/,
    )
    assert.throws(
      () => toolHandlers.editQuestion({ id: added.id, changes: { type: 'essay' } }),
      /changes.type is invalid/,
    )
    assert.throws(
      () => toolHandlers.editQuestion({ id: added.id, changes: {} }),
      /changes must contain only/,
    )
  })

  it('applies a prompt and type change through the normalized path', () => {
    const added = workspaceActions.addQuestion('short-answer')
    const result = toolHandlers.editQuestion({
      id: added.id,
      changes: { prompt: '  New prompt.', type: 'extended-response' },
    })
    assert.equal(result.question.prompt, 'New prompt.')
    assert.equal(result.question.type, 'extended-response')
    assert.equal(result.visibleState.questionCount, 1)
    assert.equal(workspaceStore.getSnapshot().activity[0].actor, 'agent')
  })

  it('fails on an unknown question id', () => {
    assert.throws(
      () => toolHandlers.editQuestion({ id: 'ghost', changes: { prompt: 'x' } }),
      /ghost was not found/,
    )
  })
})

describe('toolHandlers.swapQuestion', () => {
  it('swaps through the local fallback and returns visible state', async () => {
    toolHandlers.addSourceMaterial({ image_or_text: 'Notes about fractions.', grade: 4, subject: 'Math', topic: 'Tenths' })
    const added = workspaceActions.addQuestion('multiple-choice')
    const result = await toolHandlers.swapQuestion({ id: added.id, reason: 'swap with a decimal question' })
    assert.equal(result.question.prompt, 'Which decimal has a 7 in the hundredths place?')
    assert.equal(result.visibleState.questionCount, 1)
  })

  it('rejects swaps for unknown questions', async () => {
    await assert.rejects(
      () => toolHandlers.swapQuestion({ id: 'ghost', reason: 'swap with a decimal question' }),
      /ghost was not found/,
    )
  })
})

describe('toolHandlers read-only checks', () => {
  const mc = { id: 'c1', type: 'multiple-choice', prompt: 'Pick one.', options: ['a', 'b'], standardIds: ['4.NF.C.6'] }
  const sa = { id: 'c2', type: 'short-answer', prompt: 'Cats are small pets.', standardIds: ['4.NF.C.6'] }
  const er = { id: 'c3', type: 'extended-response', prompt: 'Write at length.', standardIds: ['4.NF.C.6'] }

  it('checks the visible worksheet by default', () => {
    const time = toolHandlers.checkTime({ worksheet: 'current' })
    assert.equal(time.unit, 'minutes')
    assert.equal(time.status, 'needs-attention')
    assert.equal(time.estimate, 0)
    const reading = toolHandlers.checkReading({ worksheet: 'current' })
    assert.equal(reading.grade, 0)
  })

  it('checks explicit worksheets and surfaces heuristic details', () => {
    const reading = toolHandlers.checkReading({
      worksheet: { questions: [sa] },
    })
    assert.equal(reading.grade, 2.8)
    assert.equal(reading.heuristic.averageSentenceLength, 4)
    const mix = toolHandlers.checkMix({
      worksheet: { questions: [mc, mc, sa, sa, er] },
    })
    assert.equal(mix.status, 'satisfied')
    const coverage = toolHandlers.checkCoverage({
      worksheet: { questions: [mc] },
      standards: ['4.NF.C.6'],
    })
    assert.equal(coverage.status, 'satisfied')
    assert.deepEqual(coverage.hit, ['4.NF.C.6'])
  })

  it('rejects malformed explicit worksheets and standards', () => {
    assert.throws(() => toolHandlers.checkTime({}), /Expected an object input/)
    assert.throws(() => toolHandlers.checkTime({ worksheet: {} }), /questions must be an array/)
    assert.throws(
      () => toolHandlers.checkTime({ worksheet: { questions: [{}] } }),
      /questions\[0\]/,
    )
    assert.throws(
      () => toolHandlers.checkCoverage({ worksheet: 'current', standards: [] }),
      /standards must contain between 1 and 12/,
    )
  })
})
