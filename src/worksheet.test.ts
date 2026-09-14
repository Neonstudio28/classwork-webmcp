import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeSourceMaterial,
  assertQuestionContent,
  checkQuestionMix,
  checkReadingLevel,
  checkStandardCoverage,
  checkTimeEstimate,
  createDraftQuestions,
  createDraftWorksheet,
  evaluateConstraints,
  generateReplacementQuestion,
  hasSourceEvidence,
  normalizeQuestionChanges,
  sourceGroundingLabel,
  toPercent,
  type Question,
  type QuestionType,
  type SourceMaterial,
} from './worksheet.ts'

let questionCounter = 0

function question(
  type: QuestionType,
  prompt: string,
  options?: string[],
  standardIds: string[] = [],
): Question {
  questionCounter += 1
  return {
    id: `q-${questionCounter}`,
    type,
    prompt,
    ...(options ? { options } : {}),
    standardIds,
  }
}

function textSource(content: string, topic = 'Fractions'): Pick<SourceMaterial, 'kind' | 'content' | 'extractedText' | 'topic'> {
  return { kind: 'text', content, topic }
}

const seventeenWords =
  'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen'

describe('checkTimeEstimate', () => {
  it('estimates zero for an empty worksheet', () => {
    const check = checkTimeEstimate({ questions: [] })
    assert.equal(check.estimate, 0)
    assert.equal(check.target, 15)
    assert.equal(check.lowerBound, 10.5)
    assert.equal(check.status, 'needs-attention')
  })

  it('uses the per-type base minutes when there is no reading', () => {
    assert.equal(checkTimeEstimate({ questions: [question('multiple-choice', '')] }).estimate, 1.4)
    assert.equal(checkTimeEstimate({ questions: [question('short-answer', '')] }).estimate, 2.2)
    assert.equal(checkTimeEstimate({ questions: [question('extended-response', '')] }).estimate, 3.8)
  })

  it('adds a reading allowance of about 170 words per minute', () => {
    const check = checkTimeEstimate({
      questions: [question('short-answer', seventeenWords)],
    })
    assert.equal(check.estimate, 2.3)
  })

  it('counts answer options toward the reading allowance', () => {
    const check = checkTimeEstimate({
      questions: [question('multiple-choice', '', seventeenWords.split(' '), [])],
    })
    assert.equal(check.estimate, 1.5)
  })
})

describe('checkReadingLevel', () => {
  it('estimates a low grade for short simple sentences', () => {
    const check = checkReadingLevel({
      questions: [question('short-answer', 'Cats are small pets.')],
    })
    assert.equal(check.grade, 2.8)
    assert.equal(check.averageSentenceLength, 4)
    assert.equal(check.longWordRatio, 0)
    assert.equal(check.status, 'needs-attention')
  })

  it('raises the estimate for long words', () => {
    const check = checkReadingLevel({
      questions: [question('short-answer', 'Photographs complicated decades.')],
    })
    assert.equal(check.grade, 5.8)
    assert.equal(check.averageSentenceLength, 3)
    assert.equal(check.longWordRatio, 0.67)
  })

  it('averages across multiple sentences', () => {
    const check = checkReadingLevel({
      questions: [question('short-answer', 'Cats are small. Dogs are big.')],
    })
    assert.equal(check.grade, 2.6)
    assert.equal(check.averageSentenceLength, 3)
  })

  it('returns grade zero for a worksheet with no readable text', () => {
    const check = checkReadingLevel({ questions: [question('multiple-choice', '')] })
    assert.equal(check.grade, 0)
  })
})

describe('checkQuestionMix', () => {
  const defaultTarget = {
    'multiple-choice': 0.4,
    'short-answer': 0.4,
    'extended-response': 0.2,
  }

  it('passes when each response type matches the target exactly', () => {
    const worksheet = {
      questions: [
        question('multiple-choice', 'a'),
        question('multiple-choice', 'b'),
        question('short-answer', 'c'),
        question('short-answer', 'd'),
        question('extended-response', 'e'),
      ],
    }
    const check = checkQuestionMix(worksheet, defaultTarget)
    assert.deepEqual(check.counts, {
      'multiple-choice': 2,
      'short-answer': 2,
      'extended-response': 1,
    })
    assert.equal(check.actual['multiple-choice'], 0.4)
    assert.equal(check.actual['short-answer'], 0.4)
    assert.equal(check.actual['extended-response'], 0.2)
    assert.equal(check.status, 'satisfied')
  })

  it('fails when a type drifts beyond the ten-point tolerance', () => {
    const worksheet = {
      questions: [
        question('multiple-choice', 'a'),
        question('short-answer', 'b'),
        question('short-answer', 'c'),
        question('extended-response', 'd'),
      ],
    }
    assert.equal(checkQuestionMix(worksheet, defaultTarget).status, 'needs-attention')
  })

  it('treats the tolerance boundary as passing', () => {
    const worksheet = {
      questions: [
        question('multiple-choice', 'a'),
        question('multiple-choice', 'b'),
        question('multiple-choice', 'c'),
        question('short-answer', 'd'),
        question('short-answer', 'e'),
        question('extended-response', 'f'),
      ],
    }
    assert.equal(checkQuestionMix(worksheet, defaultTarget).status, 'satisfied')
  })

  it('fails on an empty worksheet even when targets are equal', () => {
    const check = checkQuestionMix({ questions: [] }, defaultTarget)
    assert.equal(check.status, 'needs-attention')
    assert.deepEqual(check.actual, {
      'multiple-choice': 0,
      'short-answer': 0,
      'extended-response': 0,
    })
  })

  it('honors an explicit target ratio', () => {
    const thirds = {
      'multiple-choice': 1 / 3,
      'short-answer': 1 / 3,
      'extended-response': 1 / 3,
    }
    const worksheet = {
      questions: [
        question('multiple-choice', 'a'),
        question('short-answer', 'b'),
        question('extended-response', 'c'),
      ],
    }
    assert.equal(checkQuestionMix(worksheet, thirds).status, 'satisfied')
  })
})

describe('checkStandardCoverage', () => {
  it('reports hit and missing identifiers', () => {
    const check = checkStandardCoverage(
      { questions: [question('short-answer', 'a', undefined, ['4.NF.A.2'])] },
      ['4.NF.A.2', '4.NF.C.5'],
    )
    assert.deepEqual(check.hit, ['4.NF.A.2'])
    assert.deepEqual(check.missing, ['4.NF.C.5'])
    assert.equal(check.total, 2)
    assert.equal(check.status, 'needs-attention')
  })

  it('passes when every requested standard is tagged somewhere', () => {
    const check = checkStandardCoverage(
      {
        questions: [
          question('multiple-choice', 'a', undefined, ['4.NF.C.6']),
          question('short-answer', 'b', undefined, ['4.NF.C.6']),
        ],
      },
      ['4.NF.C.6'],
    )
    assert.deepEqual(check.hit, ['4.NF.C.6'])
    assert.deepEqual(check.missing, [])
    assert.equal(check.status, 'satisfied')
  })

  it('needs attention when no standards are requested', () => {
    const check = checkStandardCoverage(
      { questions: [question('short-answer', 'a', undefined, ['4.NF.C.6'])] },
      [],
    )
    assert.equal(check.total, 0)
    assert.equal(check.status, 'needs-attention')
  })
})

describe('evaluateConstraints', () => {
  // Five crafted questions: 2 MC, 2 SA, 1 ER, every prompt tagged 4.NF.C.6.
  const worksheet = {
    questions: [
      question('multiple-choice', 'Choose the larger fraction.', ['1/2', '1/4', 'Equal', 'Neither'], ['4.NF.C.6']),
      question('short-answer', 'Rewrite 4/10 with denominator 100.', undefined, ['4.NF.C.6']),
      question('multiple-choice', 'Choose the smaller decimal.', ['0.60', '0.64', '0.58', '0.99'], ['4.NF.C.6']),
      question('short-answer', 'Write 7/100 as a decimal.', undefined, ['4.NF.C.6']),
      question('extended-response', 'Order the decimals from least to greatest: 64/100, 60/100, 58/100.', undefined, ['4.NF.C.6']),
    ],
  }
  const baseConstraints = {
    timeLimit: 15,
    readingLevel: 4,
    questionMix: {
      'multiple-choice': 0.4,
      'short-answer': 0.4,
      'extended-response': 0.2,
    },
    standards: ['4.NF.C.6'],
  }

  it('sums the four checks into one snapshot', () => {
    const snapshot = evaluateConstraints(worksheet, baseConstraints)
    assert.equal(snapshot.total, 4)
    assert.equal(snapshot.time.estimate, 11.2)
    assert.equal(snapshot.time.status, 'satisfied')
    assert.equal(snapshot.reading.grade, 3.3)
    assert.equal(snapshot.reading.status, 'satisfied')
    assert.deepEqual(snapshot.reading.range, [3.3, 4.7])
    assert.equal(snapshot.mix.status, 'satisfied')
    assert.equal(snapshot.coverage.status, 'satisfied')
    assert.equal(snapshot.satisfiedCount, 4)
  })

  it('flags a worksheet that overshoots the time window', () => {
    const snapshot = evaluateConstraints(worksheet, { ...baseConstraints, timeLimit: 10.5 })
    assert.equal(snapshot.time.status, 'needs-attention')
    assert.equal(snapshot.satisfiedCount, 3)
  })

  it('flags a worksheet that finishes well under the window', () => {
    const snapshot = evaluateConstraints(worksheet, { ...baseConstraints, timeLimit: 20 })
    assert.equal(snapshot.time.lowerBound, 14)
    assert.equal(snapshot.time.status, 'needs-attention')
  })

  it('flags a reading level outside the +/-0.7 range', () => {
    const tooHard = evaluateConstraints(worksheet, { ...baseConstraints, readingLevel: 6 })
    assert.equal(tooHard.reading.status, 'needs-attention')
    const tooEasy = evaluateConstraints(worksheet, { ...baseConstraints, readingLevel: 2 })
    assert.equal(tooEasy.reading.status, 'needs-attention')
  })

  it('flags a question mix and missing standard coverage', () => {
    const snapshot = evaluateConstraints(worksheet, {
      ...baseConstraints,
      questionMix: {
        'multiple-choice': 0.6,
        'short-answer': 0.3,
        'extended-response': 0.1,
      },
      standards: ['4.NF.A.2'],
    })
    assert.equal(snapshot.mix.status, 'needs-attention')
    assert.equal(snapshot.coverage.status, 'needs-attention')
    assert.equal(snapshot.satisfiedCount, 2)
  })

  it('reaches 4/4 when constraints are derived from the worksheet', () => {
    const estimate = checkTimeEstimate(worksheet).estimate
    const grade = checkReadingLevel(worksheet).grade
    const snapshot = evaluateConstraints(worksheet, {
      ...baseConstraints,
      timeLimit: estimate,
      readingLevel: grade,
    })
    assert.equal(snapshot.satisfiedCount, 4)
  })
})

describe('analyzeSourceMaterial', () => {
  it('parses a fraction comparison with common denominators', () => {
    const analysis = analyzeSourceMaterial(
      textSource('Compare 3/4 and 2/5 using common denominators.'),
    )
    assert.equal(analysis.mode, 'source-text')
    assert.deepEqual(analysis.fractions, [
      { numerator: 3, denominator: 4 },
      { numerator: 2, denominator: 5 },
    ])
    assert.deepEqual(analysis.fractionComparison?.left, { numerator: 3, denominator: 4 })
    assert.deepEqual(analysis.fractionComparison?.right, { numerator: 2, denominator: 5 })
    assert.equal(analysis.fractionComparison?.commonDenominator, 20)
    assert.equal(analysis.fractionComparison?.leftEquivalentNumerator, 15)
    assert.equal(analysis.fractionComparison?.rightEquivalentNumerator, 8)
    assert.equal(analysis.fractionComparison?.relation, '>')
    assert.deepEqual(analysis.focus, ['comparing fractions with unlike denominators'])
  })

  it('detects "which fraction is greater" phrasing', () => {
    const analysis = analyzeSourceMaterial(textSource('Which fraction is greater, 1/2 or 1/3?'))
    assert.equal(analysis.fractionComparison?.relation, '>')
    assert.equal(analysis.fractionComparison?.commonDenominator, 6)
  })

  it('detects "which fraction is less" phrasing', () => {
    const analysis = analyzeSourceMaterial(textSource('Which fraction is less, 1/4 or 1/2?'))
    assert.equal(analysis.fractionComparison?.relation, '<')
  })

  it('recognizes equal fractions', () => {
    const analysis = analyzeSourceMaterial(textSource('Compare 1/2 and 2/4.'))
    assert.equal(analysis.fractionComparison?.relation, '=')
    assert.equal(analysis.fractionComparison?.commonDenominator, 4)
  })

  it('ignores denominators above 100 and skips a comparison that cannot be built', () => {
    const analysis = analyzeSourceMaterial(textSource('Compare 1/101 and 2/3.'))
    assert.deepEqual(analysis.fractions, [{ numerator: 2, denominator: 3 }])
    assert.equal(analysis.fractionComparison, undefined)
  })

  it('skips comparisons that need a common denominator above 300', () => {
    const analysis = analyzeSourceMaterial(textSource('Compare 97/98 and 96/97.'))
    assert.equal(analysis.fractions.length, 2)
    assert.equal(analysis.fractionComparison, undefined)
  })

  it('extracts tenths numerators, decimals, and focus from plain text', () => {
    const analysis = analyzeSourceMaterial(textSource('A class learns 6/10. The prices are 0.35 and 0.40.'))
    assert.equal(analysis.tenthsNumerator, 6)
    assert.deepEqual(analysis.decimals, ['0.35', '0.40'])
    assert.deepEqual(analysis.fractions, [{ numerator: 6, denominator: 10 }])
    assert.deepEqual(analysis.focus, ['equivalent tenths & hundredths', 'decimal notation'])
  })

  it('deduplicates decimals', () => {
    const analysis = analyzeSourceMaterial(textSource('The prices are 0.35 and 0.40. Also 0.35 again.'))
    assert.deepEqual(analysis.decimals, ['0.35', '0.40'])
  })

  it('defaults to a tenths numerator of three when none is present', () => {
    const analysis = analyzeSourceMaterial(textSource('Fractions with equal numerators.'))
    assert.equal(analysis.tenthsNumerator, 3)
  })

  it('uses the transcript for image sources', () => {
    const analysis = analyzeSourceMaterial({
      kind: 'image',
      content: 'data:image/png;base64,AAAA',
      extractedText: 'The grid shows 7/10 shaded.',
      topic: 'Fractions',
    })
    assert.equal(analysis.mode, 'image-transcript')
    assert.equal(analysis.tenthsNumerator, 7)
    assert.deepEqual(analysis.fractions, [{ numerator: 7, denominator: 10 }])
  })

  it('falls back to the topic for images without a transcript', () => {
    const analysis = analyzeSourceMaterial({
      kind: 'image',
      content: 'data:image/png;base64,AAAA',
      topic: 'Fraction strips',
    })
    assert.equal(analysis.mode, 'topic-fallback')
    assert.deepEqual(analysis.focus, ['Fraction strips'])
    assert.equal(hasSourceEvidence(analysis), false)
    assert.equal(sourceGroundingLabel(analysis), 'Topic-guided fallback · no local image OCR')
  })

  it('labels source-grounded analysis', () => {
    const analysis = analyzeSourceMaterial(textSource('A class learns 6/10.'))
    assert.equal(hasSourceEvidence(analysis), true)
    assert.equal(sourceGroundingLabel(analysis), 'Pasted examples ground this draft')
    const plain = analyzeSourceMaterial(textSource('A paragraph about plants.'))
    assert.equal(sourceGroundingLabel(plain), 'Pasted source grounds this draft')
  })
})

describe('createDraftQuestions', () => {
  it('always produces six questions with a 2/2/2 response mix', () => {
    const questions = createDraftQuestions()
    assert.equal(questions.length, 6)
    assert.deepEqual(
      questions.map((item) => item.type),
      [
        'multiple-choice',
        'short-answer',
        'multiple-choice',
        'short-answer',
        'extended-response',
        'extended-response',
      ],
    )
  })
})

describe('createDraftWorksheet', () => {
  const profile = { grade: 4, subject: 'Math', topic: 'Tenths' }

  it('builds comparing-fractions questions when the source compares fractions', () => {
    const draft = createDraftWorksheet(
      profile,
      textSource('Compare 3/4 and 2/5 using common denominators.'),
      ['4.NF.A.2', '4.NF.C.6'],
    )
    assert.equal(draft.title, 'Comparing Fractions')
    assert.equal(draft.questions.length, 6)
    assert.equal(draft.questions[0].id, 'q-compare-fractions')
    assert.match(draft.questions[0].prompt, /3\/4 and 2\/5/)
    assert.deepEqual(draft.questions[0].standardIds, ['4.NF.A.2'])
  })

  it('uses the math generator only for grade four math with math evidence', () => {
    const draft = createDraftWorksheet(profile, textSource('A class learns 6/10 and 40/100.'))
    assert.equal(draft.questions[0].id, 'q-equivalent-tenths')
    assert.equal(draft.title, 'Tenths Practice')
  })

  it('spreads requested standards across untagged math questions', () => {
    const draft = createDraftWorksheet(
      profile,
      textSource('A class learns 6/10 and 40/100.'),
      ['4.NF.C.5', '4.NF.A.2'],
    )
    const decimalNotation = draft.questions.find((item) => item.id === 'q-decimal-notation')
    assert.deepEqual(decimalNotation?.standardIds, ['4.NF.A.2'])
    assert.deepEqual(draft.questions[0].standardIds, ['4.NF.C.5'])
  })

  it('falls back to source-grounded questions for non-math subjects', () => {
    const draft = createDraftWorksheet(
      { grade: 4, subject: 'Science', topic: 'Plants' },
      textSource('Plants make food from sunlight.', 'Plants'),
      ['4.NF.C.5'],
    )
    assert.equal(draft.title, 'Plants Practice')
    assert.equal(draft.questions[0].id, 'q-source-idea')
    assert.equal(draft.questions.length, 6)
    assert.deepEqual(draft.questions[0].standardIds, ['4.NF.C.5'])
  })

  it('requires grade four specifically for the math generator', () => {
    const fifth = createDraftWorksheet(
      { grade: 5, subject: 'Math', topic: 'Tenths' },
      textSource('A class learns 6/10 and 40/100.'),
    )
    assert.equal(fifth.questions[0].id, 'q-source-idea')
  })

  it('generates topic-guided questions when no source is provided', () => {
    const draft = createDraftWorksheet({ grade: 4, subject: 'Math', topic: 'Fractions' })
    assert.equal(draft.title, 'Fractions Practice')
    assert.equal(draft.questions.length, 6)
    assert.equal(draft.questions[0].id, 'q-source-idea')
  })
})

describe('assertQuestionContent', () => {
  it('accepts valid questions', () => {
    const accepted = assertQuestionContent(question('short-answer', 'Explain the water cycle.'))
    assert.equal(accepted.prompt, 'Explain the water cycle.')
    assertQuestionContent(question('multiple-choice', 'Pick one.', ['a', 'b']))
  })

  it('rejects empty or under-specified questions', () => {
    assert.throws(() => assertQuestionContent(question('short-answer', '   ')), /empty/i)
    assert.throws(() => assertQuestionContent(question('multiple-choice', 'Pick one.', ['a'])), /replacement/i)
    assert.throws(() => assertQuestionContent(question('multiple-choice', 'Pick one.', ['a', '   '])), /replacement/i)
  })

  it('rejects wording that leaks agent instructions into the board', () => {
    assert.throws(
      () => assertQuestionContent(question('short-answer', 'Create a question about magnets.')),
      /instruction/i,
    )
    assert.throws(
      () => assertQuestionContent(question('short-answer', 'Swap question 1 for an open-ended one.')),
      /instruction/i,
    )
    assert.throws(
      () => assertQuestionContent(question('short-answer', 'Respond to this teacher note: list three ideas.')),
      /instruction/i,
    )
  })

  it('rejects a prompt that repeats the agent instruction', () => {
    assert.throws(
      () => assertQuestionContent(question('short-answer', 'Write about fractions.'), 'write about fractions'),
      /instruction/i,
    )
  })

  it('accepts a prompt that mentions a different topic than the instruction', () => {
    const accepted = assertQuestionContent(
      question('short-answer', 'Explain fractions using a number line.'),
      'freshwater habitats',
    )
    assert.equal(accepted.id, accepted.id)
  })
})

describe('normalizeQuestionChanges', () => {
  it('trims leading whitespace and caps the prompt', () => {
    const normalized = normalizeQuestionChanges({ prompt: '   Deep-water currents   ' })
    assert.equal(normalized.prompt, 'Deep-water currents   ')
    const long = normalizeQuestionChanges({ prompt: 'x'.repeat(950) })
    assert.equal(long.prompt?.length, 900)
  })

  it('throws on instruction-leak wording', () => {
    assert.throws(
      () => normalizeQuestionChanges({ prompt: 'Swap question 1 out' }),
      /agent instruction/i,
    )
    assert.throws(
      () => normalizeQuestionChanges({ prompt: 'Generate 3 questions now' }),
      /agent instruction/i,
    )
  })

  it('keeps valid types and drops unknown ones', () => {
    assert.deepEqual(normalizeQuestionChanges({ type: 'extended-response' }), { type: 'extended-response' })
    const dropped = normalizeQuestionChanges(
      { type: 'essay' } as unknown as Parameters<typeof normalizeQuestionChanges>[0],
    )
    assert.equal('type' in dropped, false)
  })

  it('filters and caps options and standard identifiers', () => {
    const normalized = normalizeQuestionChanges(
      {
        options: ['a', 5, null, 'b'],
        standardIds: [' 4.NF.A.2 ', '', '4.NF.C.6', 7],
      } as unknown as Parameters<typeof normalizeQuestionChanges>[0],
    )
    assert.deepEqual(normalized.options, ['a', 'b'])
    assert.deepEqual(normalized.standardIds, ['4.NF.A.2', '4.NF.C.6'])
  })

  it('returns an empty change set for empty input', () => {
    assert.deepEqual(normalizeQuestionChanges({}), {})
  })
})

describe('generateReplacementQuestion', () => {
  it('writes a decimal multiple-choice item on request', () => {
    const replacement = generateReplacementQuestion(
      question('multiple-choice', 'old prompt'),
      'swap with a decimal question',
    )
    assert.equal(replacement.prompt, 'Which decimal has a 7 in the hundredths place?')
    assert.deepEqual(replacement.options, ['0.07', '0.17', '0.70', '7.00'])
    assert.deepEqual(replacement.standardIds, ['4.NF.C.6'])
  })

  it('writes a decimal short-answer item on request', () => {
    const replacement = generateReplacementQuestion(
      question('short-answer', 'old prompt'),
      'make it about place value',
    )
    assert.match(replacement.prompt, /greater than 0\.43/)
    assert.deepEqual(replacement.standardIds, ['4.NF.C.7'])
  })

  it('writes a fraction item when fractions are requested', () => {
    const replacement = generateReplacementQuestion(
      question('multiple-choice', 'old prompt'),
      'use equivalent fractions',
    )
    assert.equal(replacement.prompt, 'Which fraction is equivalent to 6/10?')
    assert.deepEqual(replacement.standardIds, ['4.NF.C.5'])
    const short = generateReplacementQuestion(
      question('short-answer', 'old prompt'),
      'use equivalent fractions',
    )
    assert.match(short.prompt, /8\/10/)
  })

  it('prefers decimals when the reason mentions both', () => {
    const replacement = generateReplacementQuestion(
      question('multiple-choice', 'old prompt'),
      'decimal fraction equivalence',
    )
    assert.equal(replacement.prompt, 'Which decimal has a 7 in the hundredths place?')
  })

  it('extracts a concept from plain-language swap reasons', () => {
    const replacement = generateReplacementQuestion(
      question('multiple-choice', 'old prompt'),
      'swap the question for a question about photosynthesis',
    )
    assert.equal(replacement.prompt, 'Which statement best explains photosynthesis?')
    const short = generateReplacementQuestion(
      question('short-answer', 'old prompt'),
      'create a new item about the water cycle',
    )
    assert.equal(short.prompt, 'Use evidence from the class material to explain the water cycle.')
  })

  it('requires a concept for generic swaps', () => {
    assert.throws(
      () => generateReplacementQuestion(question('short-answer', 'old prompt'), 'create a new question'),
      /Name the concept/,
    )
  })
})

describe('toPercent', () => {
  it('clamps ratios between zero and one', () => {
    assert.equal(toPercent(0.5), '50%')
    assert.equal(toPercent(0.375), '38%')
    assert.equal(toPercent(0), '0%')
    assert.equal(toPercent(1), '100%')
    assert.equal(toPercent(1.4), '100%')
    assert.equal(toPercent(-0.2), '0%')
  })
})
