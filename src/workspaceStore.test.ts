import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { WorkspaceState } from './worksheet.ts'
import {
  currentConstraintSnapshot,
  runAgentInstruction,
  workspaceActions,
  workspaceStore,
} from './workspaceStore.ts'

const originalFetch = globalThis.fetch

const TEXT_SOURCE = 'Plants use sunlight to make food. Chlorophyll captures light energy.'
const IMAGE_SOURCE = 'data:image/png;base64,AAAA'

function rejectNetwork() {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed')
  }
}

function respondWith(payload: unknown) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
}

function seedTextSource() {
  return workspaceActions.addSourceMaterial(TEXT_SOURCE, 4, 'Science', 'Plants')
}

function makeWorkspaceState(): WorkspaceState {
  return {
    version: 2,
    modifiedAt: new Date(0).toISOString(),
    profile: { grade: 4, subject: 'Science', topic: 'Plants' },
    source: null,
    worksheet: {
      title: '',
      subtitle: '',
      questions: [],
      updatedAt: new Date(0).toISOString(),
    },
    constraints: {
      timeLimit: 15,
      readingLevel: 4,
      questionMix: {
        'multiple-choice': 0.4,
        'short-answer': 0.4,
        'extended-response': 0.2,
      },
      standards: [],
    },
    hasDraft: false,
    activity: [],
    lastAgentMessage: '',
    lastError: '',
  }
}

function laterThan(dateIso: string, hours = 24) {
  return new Date(new Date(dateIso).getTime() + hours * 3_600_000).toISOString()
}

beforeEach(() => {
  rejectNetwork()
  workspaceActions.reset()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('workspaceStore initial state', () => {
  it('starts empty with default constraints', () => {
    const state = workspaceStore.getSnapshot()
    assert.equal(state.version, 2)
    assert.equal(state.source, null)
    assert.equal(state.hasDraft, false)
    assert.deepEqual(state.worksheet.questions, [])
    assert.equal(state.constraints.timeLimit, 15)
    assert.equal(currentConstraintSnapshot().satisfiedCount, 0)
  })
})

describe('updateProfile', () => {
  it('clamps grades into 1-12 and resets the draft', () => {
    workspaceActions.addQuestion('multiple-choice')
    workspaceActions.updateProfile({ grade: 15, subject: '  Math', topic: 'Fractions' })
    const state = workspaceStore.getSnapshot()
    assert.equal(state.profile.grade, 12)
    assert.equal(state.profile.subject, 'Math')
    assert.equal(state.constraints.readingLevel, 12)
    assert.deepEqual(state.worksheet.questions, [])
    assert.equal(state.hasDraft, false)
  })

  it('rejects a non-finite grade', () => {
    assert.throws(() => workspaceActions.updateProfile({ grade: Number.NaN }), /number from 1 to 12/)
  })
})

describe('addSourceMaterial', () => {
  it('stages text and updates the profile and activity', () => {
    const source = seedTextSource()
    const state = workspaceStore.getSnapshot()
    assert.equal(source.kind, 'text')
    assert.equal(state.source?.content, TEXT_SOURCE)
    assert.equal(state.profile.subject, 'Science')
    assert.equal(state.profile.grade, 4)
    assert.equal(state.activity[0].action, 'Added source material')
    assert.equal(state.activity[0].actor, 'teacher')
  })

  it('rejects remote URLs and unsupported images', () => {
    assert.throws(
      () => workspaceActions.addSourceMaterial('https://example.com/notes.png', 4, 'Math', 'Tenths'),
      /Remote image URLs are not supported/,
    )
    assert.throws(
      () => workspaceActions.addSourceMaterial('/notes.png', 4, 'Math', 'Tenths'),
      /Remote image URLs are not supported/,
    )
    assert.throws(
      () => workspaceActions.addSourceMaterial('data:image/gif;base64,AAAA', 4, 'Math', 'Tenths'),
      /inline PNG, JPEG, or WebP/,
    )
    assert.throws(
      () => workspaceActions.addSourceMaterial('data:image/png;base64,AAAA', 0, 'Math', 'Tenths'),
      /whole number from 1 to 12/,
    )
    assert.throws(
      () => workspaceActions.addSourceMaterial('   ', 4, 'Math', 'Tenths'),
      /cannot be empty/,
    )
  })

  it('accepts inline PNG data URLs as image sources', () => {
    const source = workspaceActions.addSourceMaterial(IMAGE_SOURCE, 4, 'Math', 'Tenths')
    assert.equal(source.kind, 'image')
    assert.equal(workspaceStore.getSnapshot().source?.kind, 'image')
  })

  it('clears an existing draft when new source arrives', async () => {
    seedTextSource()
    await workspaceActions.generateDraft()
    assert.equal(workspaceStore.getSnapshot().hasDraft, true)
    workspaceActions.addSourceMaterial('Brand new source about decimals.', 4, 'Math', 'Tenths')
    assert.equal(workspaceStore.getSnapshot().hasDraft, false)
  })
})

describe('removeSource and updateSourceTranscript', () => {
  it('removes the source and rebuilds an empty workspace', async () => {
    seedTextSource()
    await workspaceActions.generateDraft()
    workspaceActions.removeSource()
    const state = workspaceStore.getSnapshot()
    assert.equal(state.source, null)
    assert.equal(state.hasDraft, false)
    assert.deepEqual(state.worksheet.questions, [])
    assert.deepEqual(state.activity, [])
  })

  it('requires an image before editing the transcript', () => {
    seedTextSource()
    assert.throws(() => workspaceActions.updateSourceTranscript('A transcript.'), /image source/)
    workspaceActions.removeSource()
    workspaceActions.addSourceMaterial(IMAGE_SOURCE, 4, 'Math', 'Tenths')
    const source = workspaceActions.updateSourceTranscript('  The grid shows 7/10 shaded.  ')
    assert.equal(source?.extractedText, 'The grid shows 7/10 shaded.  ')
    const cleared = workspaceActions.updateSourceTranscript('')
    assert.equal(cleared?.extractedText, undefined)
  })
})

describe('setConstraints', () => {
  it('merges valid changes and deduplicates standards', () => {
    workspaceActions.setConstraints({
      timeLimit: 20,
      standards: [' 4.NF.A.2 ', '4.NF.A.2', '4.NF.C.5'],
    })
    const state = workspaceStore.getSnapshot()
    assert.equal(state.constraints.timeLimit, 20)
    assert.deepEqual(state.constraints.standards, ['4.NF.A.2', '4.NF.C.5'])
  })

  it('rejects out-of-range or inconsistent constraints', () => {
    assert.throws(() => workspaceActions.setConstraints({ timeLimit: 4 }), /between 5 and 45/)
    assert.throws(() => workspaceActions.setConstraints({ readingLevel: 13 }), /between Grade 1 and Grade 12/)
    assert.throws(
      () => workspaceActions.setConstraints({
        questionMix: { 'multiple-choice': 0.5, 'short-answer': 0.4, 'extended-response': 0.2 },
      }),
      /ratios from 0 to 1/,
    )
    assert.throws(() => workspaceActions.setConstraints({ timeLimit: 4 }), /between 5 and 45/)
    const unchanged = workspaceStore.getSnapshot().constraints.timeLimit
    assert.equal(unchanged, 15)
  })
})

describe('question editing', () => {
  it('adds questions tagged with the first configured standard', () => {
    workspaceActions.setConstraints({ standards: ['4.NF.C.5'] })
    const added = workspaceActions.addQuestion('multiple-choice')
    assert.equal(added.type, 'multiple-choice')
    assert.deepEqual(added.standardIds, ['4.NF.C.5'])
    assert.equal(workspaceStore.getSnapshot().hasDraft, true)
    assert.equal(workspaceStore.getSnapshot().activity[0].action, 'Added question')
  })

  it('edits a question by id and logs the change', () => {
    const added = workspaceActions.addQuestion('short-answer')
    const edited = workspaceActions.editQuestion(added.id, {
      prompt: '   Use evidence to explain photosynthesis.',
      type: 'extended-response',
      standardIds: ['4.NF.C.6'],
    })
    assert.equal(edited.prompt, 'Use evidence to explain photosynthesis.')
    assert.equal(edited.type, 'extended-response')
    assert.deepEqual(edited.standardIds, ['4.NF.C.6'])
    assert.equal(workspaceStore.getSnapshot().activity[0].action, 'Edited question')
  })

  it('skips activity logging when requested', () => {
    const added = workspaceActions.addQuestion('short-answer')
    const before = workspaceStore.getSnapshot().activity.length
    workspaceActions.editQuestion(added.id, { prompt: 'New wording.' }, 'agent', false)
    assert.equal(workspaceStore.getSnapshot().activity.length, before)
  })

  it('rejects instruction-leak wording and records the error', () => {
    const added = workspaceActions.addQuestion('short-answer')
    assert.throws(
      () => workspaceActions.editQuestion(added.id, { prompt: 'Create a question about frogs.' }),
      /agent instruction/,
    )
    assert.match(workspaceStore.getSnapshot().lastError, /agent instruction/)
  })

  it('throws for unknown question ids', () => {
    assert.throws(() => workspaceActions.editQuestion('missing', { prompt: 'x' }), /was not found/)
    assert.throws(() => workspaceActions.deleteQuestion('missing'), /was not found/)
  })

  it('removes and reorders questions within bounds', () => {
    const first = workspaceActions.addQuestion('short-answer')
    const second = workspaceActions.addQuestion('multiple-choice')
    const third = workspaceActions.addQuestion('extended-response')
    workspaceActions.moveQuestion(first.id, 99)
    assert.deepEqual(
      workspaceStore.getSnapshot().worksheet.questions.map((item) => item.id),
      [second.id, third.id, first.id],
    )
    workspaceActions.deleteQuestion(first.id, 'teacher')
    assert.deepEqual(
      workspaceStore.getSnapshot().worksheet.questions.map((item) => item.id),
      [second.id, third.id],
    )
    assert.equal(workspaceStore.getSnapshot().activity[0].action, 'Removed question')
  })

  it('caps the worksheet title', () => {
    workspaceActions.setWorksheetTitle('T'.repeat(120))
    assert.equal(workspaceStore.getSnapshot().worksheet.title.length, 100)
  })
})

describe('generateDraft', () => {
  it('requires source material and a subject and topic', async () => {
    await assert.rejects(() => workspaceActions.generateDraft(), /Add source material/)
    workspaceActions.addSourceMaterial(TEXT_SOURCE, 4, '', 'Plants')
    await assert.rejects(() => workspaceActions.generateDraft(), /Set the subject and topic/)
  })

  it('commits a source-grounded local fallback when the API is unavailable', async () => {
    seedTextSource()
    const draft = await workspaceActions.generateDraft()
    const state = workspaceStore.getSnapshot()
    assert.equal(draft.questions.length, 6)
    assert.equal(state.hasDraft, true)
    assert.equal(state.lastError, '')
    assert.match(state.lastAgentMessage, /local fallback/)
    assert.equal(state.activity[0].action, 'Generated source-grounded local fallback')
  })

  it('commits the Gemini worksheet when the API returns one', async () => {
    seedTextSource()
    respondWith({
      worksheet: {
        title: 'Gemini Draft',
        subtitle: '',
        updatedAt: new Date().toISOString(),
        questions: [
          {
            id: 'g1',
            type: 'multiple-choice',
            prompt: 'Which is closest to the source?',
            options: ['Sunlight', 'Rocks'],
            standardIds: ['4.NF.C.6'],
          },
          {
            id: 'g2',
            type: 'short-answer',
            prompt: 'Explain chlorophyll.',
            standardIds: ['4.NF.C.6'],
          },
        ],
      },
      mode: 'gemini',
      model: 'gemini-3.6-flash',
      sourceEvidence: [],
      sourceMode: 'source-text',
    })
    const draft = await workspaceActions.generateDraft()
    assert.equal(draft.title, 'Gemini Draft')
    const state = workspaceStore.getSnapshot()
    assert.equal(state.worksheet.title, 'Gemini Draft')
    assert.match(state.lastAgentMessage, /Gemini/)
    assert.equal(state.activity[0].action, 'Generated source-grounded draft with Gemini')
  })

  it('stores vision evidence on image sources after a Gemini draft', async () => {
    workspaceActions.addSourceMaterial(IMAGE_SOURCE, 4, 'Math', 'Tenths')
    respondWith({
      worksheet: {
        title: 'Vision Draft',
        subtitle: '',
        updatedAt: new Date().toISOString(),
        questions: [
          {
            id: 'v1',
            type: 'short-answer',
            prompt: 'Explain the shaded grid.',
            standardIds: ['4.NF.C.6'],
          },
        ],
      },
      mode: 'gemini',
      model: 'gemini-3.6-flash',
      sourceEvidence: ['The grid shows 7/10 shaded.'],
      sourceMode: 'image-vision',
    })
    await workspaceActions.generateDraft()
    assert.equal(workspaceStore.getSnapshot().source?.extractedText, 'The grid shows 7/10 shaded.')
  })

  it('uses the local fallback for image sources too', async () => {
    workspaceActions.addSourceMaterial(IMAGE_SOURCE, 4, 'Math', 'Tenths')
    const draft = await workspaceActions.generateDraft()
    assert.equal(draft.questions.length, 6)
    assert.match(workspaceStore.getSnapshot().lastAgentMessage, /local fallback/)
  })
})

describe('swapQuestion', () => {
  it('replaces the question in place through the local fallback', async () => {
    seedTextSource()
    const original = workspaceActions.addQuestion('multiple-choice')
    const replacement = await workspaceActions.swapQuestion(original.id, 'swap with a decimal question')
    const state = workspaceStore.getSnapshot()
    assert.equal(replacement.prompt, 'Which decimal has a 7 in the hundredths place?')
    assert.equal(state.worksheet.questions.length, 1)
    assert.equal(state.worksheet.questions[0].id, original.id)
    assert.match(state.lastAgentMessage, /local fallback/)
  })

  it('commits a Gemini replacement when the API returns one', async () => {
    seedTextSource()
    const original = workspaceActions.addQuestion('multiple-choice')
    respondWith({
      question: {
        id: original.id,
        type: 'multiple-choice',
        prompt: 'Which decimal has a 7 in the hundredths place?',
        options: ['0.07', '0.17', '0.70', '7.00'],
        standardIds: ['4.NF.C.6'],
      },
      mode: 'gemini',
      model: 'gemini-3.6-flash',
    })
    const replacement = await workspaceActions.swapQuestion(original.id, 'swap with a decimal question')
    assert.equal(replacement.prompt, 'Which decimal has a 7 in the hundredths place?')
    assert.match(workspaceStore.getSnapshot().lastAgentMessage, /with Gemini/)
  })

  it('fails closed when the replacement repeats the instruction', async () => {
    seedTextSource()
    const original = workspaceActions.addQuestion('short-answer')
    respondWith({
      question: {
        id: original.id,
        type: 'short-answer',
        prompt: 'Swap with a decimal question',
        standardIds: [],
      },
      mode: 'gemini',
      model: 'gemini-3.6-flash',
    })
    await assert.rejects(
      () => workspaceActions.swapQuestion(original.id, 'swap with a decimal question'),
      /instruction/i,
    )
    assert.equal(
      workspaceStore.getSnapshot().worksheet.questions[0].prompt,
      'Use evidence from the class material to explain Plants.',
    )
  })

  it('requires source material before swapping', async () => {
    const added = workspaceActions.addQuestion('short-answer')
    await assert.rejects(
      () => workspaceActions.swapQuestion(added.id, 'swap with a decimal question'),
      /Add source material/,
    )
  })
})

describe('runAgentInstruction', () => {
  it('validates the instruction and draft state', async () => {
    await assert.rejects(() => runAgentInstruction('   '), /Enter an instruction/)
    await assert.rejects(() => runAgentInstruction('anything'), /before asking for revisions/)
  })

  it('routes swap requests to the first question when no fraction item exists', async () => {
    seedTextSource()
    const original = workspaceActions.addQuestion('multiple-choice')
    const replacement = await runAgentInstruction('swap in a decimal focused question')
    assert.equal(replacement?.id, original.id)
    assert.equal(replacement?.type, 'multiple-choice')
    assert.match(replacement?.prompt ?? '', /decimal has a 7/)
  })

  it('targets fraction questions for swap requests', async () => {
    seedTextSource()
    workspaceActions.addQuestion('short-answer')
    const fraction = workspaceActions.addQuestion('extended-response')
    workspaceActions.editQuestion(fraction.id, { prompt: 'Show how 8/10 becomes hundredths.' })
    const replacement = await runAgentInstruction('swap the fraction question')
    assert.equal(replacement?.id, fraction.id)
  })

  it('removes the last extended-response item when asked to shorten', async () => {
    seedTextSource()
    workspaceActions.addQuestion('short-answer')
    const extended = workspaceActions.addQuestion('extended-response')
    const removed = await runAgentInstruction('make the worksheet shorter')
    assert.equal(removed?.id, extended.id)
    const state = workspaceStore.getSnapshot()
    assert.equal(state.worksheet.questions.length, 1)
    assert.match(state.lastAgentMessage, /Removed the final extended-response/)
  })

  it('reports when there is nothing left to shorten', async () => {
    seedTextSource()
    workspaceActions.addQuestion('short-answer')
    const result = await runAgentInstruction('too long, make it shorter')
    assert.equal(result, null)
    assert.match(workspaceStore.getSnapshot().lastAgentMessage, /no extended-response/)
  })

  it('adds a multiple-choice item when asked for more', async () => {
    seedTextSource()
    workspaceActions.addQuestion('short-answer')
    const before = workspaceStore.getSnapshot().worksheet.questions.length
    const added = await runAgentInstruction('add two more multiple choice items')
    assert.equal(added?.type, 'multiple-choice')
    assert.equal(workspaceStore.getSnapshot().worksheet.questions.length, before + 1)
  })

  it('explains its capabilities for unrecognized instructions', async () => {
    seedTextSource()
    workspaceActions.addQuestion('short-answer')
    const result = await runAgentInstruction('make it purple')
    assert.equal(result, null)
    assert.match(workspaceStore.getSnapshot().lastAgentMessage, /swap a question/)
  })
})

describe('hydrate', () => {
  function remoteState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
    const now = workspaceStore.getSnapshot().modifiedAt
    const timestamp = laterThan(now)
    return {
      ...makeWorkspaceState(),
      modifiedAt: timestamp,
      worksheet: {
        title: 'Hydrated',
        subtitle: '',
        updatedAt: timestamp,
        questions: [
          {
            id: 'h1',
            type: 'multiple-choice',
            prompt: 'Which is accurate?',
            options: ['A', 'B'],
            standardIds: ['4.NF.C.6'],
          },
        ],
      },
      hasDraft: true,
      activity: [
        { id: 'a1', actor: 'agent', action: 'Ran swap_question', detail: 'Question 1', createdAt: timestamp },
      ],
      ...overrides,
    }
  }

  it('loads a valid remote workspace that is newer than local', async () => {
    respondWith({ workspace: remoteState() })
    await workspaceActions.hydrate()
    const state = workspaceStore.getSnapshot()
    assert.equal(state.worksheet.title, 'Hydrated')
    assert.equal(state.worksheet.questions.length, 1)
    assert.equal(state.worksheet.questions[0].standardIds[0], '4.NF.C.6')
    assert.equal(state.hasDraft, true)
    assert.equal(state.activity[0].actor, 'agent')
  })

  it('ignores remote workspaces older than the local state', async () => {
    const before = workspaceStore.getSnapshot().modifiedAt
    respondWith({
      workspace: {
        ...remoteState(),
        modifiedAt: '1999-01-01T00:00:00.000Z',
        worksheet: {
          title: 'Stale',
          subtitle: '',
          updatedAt: '1999-01-01T00:00:01.000Z',
          questions: [
            { id: 's1', type: 'short-answer', prompt: 'Old question.', standardIds: [] },
          ],
        },
        activity: [
          { id: 's2', actor: 'system', action: 'Generated draft', detail: 'old', createdAt: '1999-01-01T00:00:02.000Z' },
        ],
      },
    })
    await workspaceActions.hydrate()
    assert.equal(workspaceStore.getSnapshot().modifiedAt, before)
    assert.deepEqual(workspaceStore.getSnapshot().worksheet.questions, [])
  })

  it('rejects malformed or invalid remote workspaces', async () => {
    const before = workspaceStore.getSnapshot().modifiedAt
    respondWith({
      workspace: remoteState({ version: 3 } as unknown as Partial<WorkspaceState>),
    })
    await workspaceActions.hydrate()
    assert.equal(workspaceStore.getSnapshot().modifiedAt, before)

    respondWith({
      workspace: remoteState({
        worksheet: {
          title: 'Hydrated',
          subtitle: '',
          updatedAt: laterThan(before),
          questions: [{ id: '', type: 'multiple-choice', prompt: 'x', standardIds: [] }],
        },
      }),
    })
    await workspaceActions.hydrate()
    assert.equal(workspaceStore.getSnapshot().modifiedAt, before)

    respondWith({
      workspace: remoteState({
        profile: { grade: 99, subject: 'Math', topic: 'Tenths' },
      }),
    })
    await workspaceActions.hydrate()
    assert.equal(workspaceStore.getSnapshot().modifiedAt, before)
  })

  it('infers modifiedAt from content timestamps when missing', async () => {
    const timestamp = laterThan(workspaceStore.getSnapshot().modifiedAt)
    respondWith({
      workspace: remoteState({
        modifiedAt: '',
        worksheet: {
          title: 'Hydrated',
          subtitle: '',
          updatedAt: timestamp,
          questions: [
            { id: 'h1', type: 'multiple-choice', prompt: 'Which is accurate?', options: ['A', 'B'], standardIds: ['4.NF.C.6'] },
          ],
        },
      }),
    })
    await workspaceActions.hydrate()
    assert.equal(workspaceStore.getSnapshot().worksheet.title, 'Hydrated')
    assert.ok(new Date(workspaceStore.getSnapshot().modifiedAt).getTime() >= new Date(timestamp).getTime())
  })
})
