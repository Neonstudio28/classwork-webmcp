import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  Bot,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clock3,
  FileText,
  Gauge,
  GripVertical,
  ImagePlus,
  ListChecks,
  LockKeyhole,
  LoaderCircle,
  MessageSquare,
  Minus,
  Plus,
  Printer,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  UserRound,
  WandSparkles,
} from 'lucide-react'
import './App.css'
import {
  QUESTION_TYPE_LABELS,
  STANDARD_LIBRARY,
  analyzeSourceMaterial,
  evaluateConstraints,
  sourceGroundingLabel,
  toPercent,
  type ConstraintSnapshot,
  type Question,
  type QuestionType,
} from './worksheet'
import { registerClassworkTools } from './webmcp'
import {
  runAgentInstruction,
  workspaceActions,
  workspaceStore,
} from './workspaceStore'

type CheckStatus = 'satisfied' | 'needs-attention' | 'idle'

const QUESTION_TYPES = Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]

function useAnimatedNumber(value: number, duration = 260) {
  const [display, setDisplay] = useState(value)
  const previous = useRef(value)

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
      previous.current = value
      const frame = requestAnimationFrame(() => setDisplay(value))
      return () => cancelAnimationFrame(frame)
    }

    const from = previous.current
    const startedAt = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration)
      const eased = 1 - (1 - progress) ** 3
      setDisplay(from + (value - from) * eased)
      if (progress < 1) frame = requestAnimationFrame(tick)
      else previous.current = value
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [duration, value])

  return display
}

function relativeTime(iso: string) {
  const elapsed = Math.max(0, Date.now() - new Date(iso).getTime())
  if (elapsed < 45_000) return 'now'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

async function resizeImage(file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read that image.'))
    reader.readAsDataURL(file)
  })

  if (file.type === 'image/svg+xml') return dataUrl

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const preview = new Image()
    preview.onload = () => resolve(preview)
    preview.onerror = () => reject(new Error('Could not decode that image.'))
    preview.src = dataUrl
  })
  const maxDimension = 1280
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(image.width * scale)
  canvas.height = Math.round(image.height * scale)
  const context = canvas.getContext('2d')
  if (!context) return dataUrl
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.82)
}

interface InstrumentProps {
  label: string
  icon: ReactNode
  status: CheckStatus
  value: ReactNode
  target: string
  description: string
  highlighted?: boolean
  children?: ReactNode
}

function Instrument({ label, icon, status, value, target, description, highlighted = false, children }: InstrumentProps) {
  return (
    <section className={`instrument instrument--${status} ${highlighted ? 'instrument--highlighted' : ''}`} aria-label={`${label}: ${description}`}>
      <div className="instrument__topline">
        <span className="instrument__label">{icon}{label}</span>
        <span className="instrument__state" aria-hidden="true">
          {status === 'satisfied' ? <Check size={14} /> : status === 'needs-attention' ? <CircleAlert size={14} /> : null}
        </span>
      </div>
      <div className="instrument__reading">
        <span className="instrument__value">{value}</span>
        <span className="instrument__target">{target}</span>
      </div>
      {children}
      <p className="instrument__description">{description}</p>
    </section>
  )
}

function ConstraintPanel({ snapshot, hasDraft }: { snapshot: ConstraintSnapshot; hasDraft: boolean }) {
  const time = useAnimatedNumber(hasDraft ? snapshot.time.estimate : 0)
  const reading = useAnimatedNumber(hasDraft ? snapshot.reading.grade : 0)
  const coverage = useAnimatedNumber(hasDraft ? snapshot.coverage.hit.length : 0)
  const satisfied = useAnimatedNumber(hasDraft ? snapshot.satisfiedCount : 0)
  const status = (value: 'satisfied' | 'needs-attention'): CheckStatus => hasDraft ? value : 'idle'
  const [highlighted, setHighlighted] = useState<string[]>([])
  const previousStatuses = useRef<Record<string, CheckStatus>>({})

  useEffect(() => {
    const currentStatuses: Record<string, CheckStatus> = hasDraft
      ? { time: snapshot.time.status, reading: snapshot.reading.status, mix: snapshot.mix.status, coverage: snapshot.coverage.status }
      : { time: 'idle', reading: 'idle', mix: 'idle', coverage: 'idle' }
    const newlySatisfied = Object.keys(currentStatuses).filter((key) =>
      previousStatuses.current[key] === 'needs-attention' && currentStatuses[key] === 'satisfied',
    )
    previousStatuses.current = currentStatuses
    if (!newlySatisfied.length) return
    setHighlighted(newlySatisfied)
    const timeout = window.setTimeout(() => setHighlighted([]), 900)
    return () => window.clearTimeout(timeout)
  }, [hasDraft, snapshot.coverage.status, snapshot.mix.status, snapshot.reading.status, snapshot.time.status])

  return (
    <div className="constraint-panel glass-raised">
      <div className="panel-heading constraint-heading">
        <div><p className="eyebrow">Live constraints</p><h2>Fit check</h2></div>
        <div className={`fit-count ${hasDraft && snapshot.satisfiedCount === 4 ? 'fit-count--done' : ''}`}>
          <span>{Math.round(satisfied)}</span><small>/4</small>
        </div>
      </div>

      <div className="instrument-cluster">
        <Instrument
          label="Completion time"
          icon={<Clock3 size={15} />}
          status={status(snapshot.time.status)}
          highlighted={highlighted.includes('time')}
          value={hasDraft ? `${time.toFixed(1)} min` : '—'}
          target={`target ${snapshot.time.target} min`}
          description={!hasDraft ? 'Waiting for a draft' : snapshot.time.status === 'satisfied' ? 'Fits the class window' : snapshot.time.estimate > snapshot.time.target ? `${(snapshot.time.estimate - snapshot.time.target).toFixed(1)} minutes over the limit` : 'Needs more useful practice'}
        >
          <div className="meter" aria-hidden="true">
            <span className="meter__fill" style={{ width: hasDraft ? `${Math.min(100, (snapshot.time.estimate / snapshot.time.target) * 100)}%` : '0%' }} />
            <i className="meter__target" />
          </div>
        </Instrument>

        <Instrument
          label="Reading level"
          icon={<Gauge size={15} />}
          status={status(snapshot.reading.status)}
          highlighted={highlighted.includes('reading')}
          value={hasDraft ? `Grade ${reading.toFixed(1)}` : '—'}
          target={`range ${snapshot.reading.range[0]}–${snapshot.reading.range[1]}`}
          description={!hasDraft ? 'Waiting for a draft' : snapshot.reading.status === 'satisfied' ? 'Accessible for Grade 4' : snapshot.reading.grade > snapshot.reading.target ? 'Simplify sentence length or vocabulary' : 'Language may be too simple for the target'}
        >
          <div className="grade-scale" aria-hidden="true">
            {[3, 4, 5].map((grade) => <span key={grade} className={Math.round(snapshot.reading.grade) === grade && hasDraft ? 'is-current' : ''}>{grade}</span>)}
          </div>
        </Instrument>

        <Instrument
          label="Question balance"
          icon={<ListChecks size={15} />}
          status={status(snapshot.mix.status)}
          highlighted={highlighted.includes('mix')}
          value={hasDraft ? `${snapshot.mix.counts['multiple-choice']} · ${snapshot.mix.counts['short-answer']} · ${snapshot.mix.counts['extended-response']}` : '—'}
          target="target 40 · 40 · 20"
          description={!hasDraft ? 'Waiting for a draft' : snapshot.mix.status === 'satisfied' ? 'Balanced across three response modes' : 'Extended response is overrepresented'}
        >
          <div className="mix-bars" role="img" aria-label="Multiple choice, short answer, and extended response percentages">
            {QUESTION_TYPES.map((type) => <span key={type} className={`mix-bar mix-bar--${type}`}><i style={{ width: hasDraft ? toPercent(snapshot.mix.actual[type]) : '0%' }} /></span>)}
          </div>
          <div className="mix-legend" aria-hidden="true"><span>MC</span><span>Short</span><span>Extended</span></div>
        </Instrument>

        <Instrument
          label="Standards coverage"
          icon={<ShieldCheck size={15} />}
          status={status(snapshot.coverage.status)}
          highlighted={highlighted.includes('coverage')}
          value={hasDraft ? `${Math.round(coverage)} of ${snapshot.coverage.total}` : '—'}
          target="required standards"
          description={!hasDraft ? 'Waiting for a draft' : snapshot.coverage.status === 'satisfied' ? 'Every selected standard is represented' : `Missing ${snapshot.coverage.missing.join(', ')}`}
        >
          <div className="coverage-track" aria-hidden="true">
            {snapshot.coverage.total > 0 && Array.from({ length: snapshot.coverage.total }).map((_, index) => <span key={index} className={hasDraft && index < snapshot.coverage.hit.length ? 'is-hit' : ''} />)}
          </div>
        </Instrument>
      </div>

      <div className={`readiness ${hasDraft && snapshot.satisfiedCount === 4 ? 'readiness--ready' : ''}`}>
        <div className="readiness__mark">{hasDraft && snapshot.satisfiedCount === 4 ? <Check size={17} /> : <ListChecks size={17} />}</div>
        <div>
          <strong>{hasDraft && snapshot.satisfiedCount === 4 ? 'Ready for class' : 'Draft in progress'}</strong>
          <span>{hasDraft && snapshot.satisfiedCount === 4 ? 'All constraints are satisfied.' : 'Resolve every check to finish.'}</span>
        </div>
      </div>
      {hasDraft && snapshot.satisfiedCount === 4 && (
        <p className="product-principle">
          This isn't AI writing your worksheet — it's making sure the one you build together actually fits your class.
        </p>
      )}
    </div>
  )
}

interface QuestionCardProps {
  question: Question
  index: number
  total: number
  dragging: boolean
  onDragStart: (event: DragEvent<HTMLElement>, id: string) => void
  onDragEnd: () => void
  onDropAt: (event: DragEvent<HTMLElement>, index: number) => void
  pending?: boolean
}

function QuestionCard({ question, index, total, dragging, onDragStart, onDragEnd, onDropAt, pending = false }: QuestionCardProps) {
  const rewriteStarted = useRef(question.prompt)
  const moveByKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.altKey) return
    if (event.key === 'ArrowUp' && index > 0) {
      event.preventDefault()
      workspaceActions.moveQuestion(question.id, index - 1)
    }
    if (event.key === 'ArrowDown' && index < total - 1) {
      event.preventDefault()
      workspaceActions.moveQuestion(question.id, index + 1)
    }
  }

  return (
    <article className={`question-card ${dragging ? 'question-card--dragging' : ''} ${pending ? 'question-card--pending' : ''}`} aria-busy={pending} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDropAt(event, index)}>
      <div className="question-card__rail">
        <span className="question-number">{String(index + 1).padStart(2, '0')}</span>
        <button type="button" className="icon-button drag-handle" draggable onDragStart={(event) => onDragStart(event, question.id)} onDragEnd={onDragEnd} onKeyDown={moveByKeyboard} aria-label={`Move question ${index + 1}. Drag, or press Alt and an arrow key.`} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" title="Drag to reorder · Alt + arrow keys">
          <GripVertical size={17} />
        </button>
      </div>

      <div className="question-card__body">
        <div className="question-meta">
          <label>
            <span className="sr-only">Question {index + 1} type</span>
            <select value={question.type} disabled={pending} onChange={(event) => workspaceActions.editQuestion(question.id, { type: event.target.value as QuestionType })}>
              {QUESTION_TYPES.map((type) => <option key={type} value={type}>{QUESTION_TYPE_LABELS[type]}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">Question {index + 1} standard</span>
            <select value={question.standardIds[0] ?? ''} disabled={pending} onChange={(event) => workspaceActions.editQuestion(question.id, { standardIds: [event.target.value] })}>
              {STANDARD_LIBRARY.map((standard) => <option key={standard.id} value={standard.id}>{standard.id}</option>)}
            </select>
          </label>
        </div>

        <label className="question-prompt-label">
          <span className="sr-only">Question {index + 1} prompt</span>
          <textarea
            value={question.prompt}
            rows={question.type === 'extended-response' ? 4 : 3}
            readOnly={pending}
            onFocus={() => { rewriteStarted.current = question.prompt }}
            onChange={(event) => workspaceActions.editQuestion(question.id, { prompt: event.target.value }, 'teacher', false)}
            onBlur={() => { if (rewriteStarted.current !== question.prompt) workspaceActions.logQuestionRewrite(question.id) }}
          />
        </label>

        {question.type === 'multiple-choice' && question.options && (
          <div className="choice-grid" role="group" aria-label={`Answer choices for question ${index + 1}`}>
            {question.options.map((option, optionIndex) => <span key={`${question.id}-${optionIndex}`}><b>{String.fromCharCode(65 + optionIndex)}</b>{option}</span>)}
          </div>
        )}

        <div className="question-card__actions">
          <span className="question-support">{pending ? <><LoaderCircle size={11} className="pending-spinner" /> Generating replacement…</> : 'Updates checks as you type'}</span>
          <div>
            <button type="button" className="icon-button" onClick={() => workspaceActions.moveQuestion(question.id, index - 1)} disabled={pending || index === 0} aria-label={`Move question ${index + 1} up`} title="Move up"><ChevronUp size={16} /></button>
            <button type="button" className="icon-button" onClick={() => workspaceActions.moveQuestion(question.id, index + 1)} disabled={pending || index === total - 1} aria-label={`Move question ${index + 1} down`} title="Move down"><ChevronDown size={16} /></button>
            <button type="button" className="icon-button icon-button--danger" onClick={() => workspaceActions.deleteQuestion(question.id)} disabled={pending} aria-label={`Delete question ${index + 1}`} title="Delete question"><Trash2 size={16} /></button>
          </div>
        </div>
      </div>
    </article>
  )
}

function App() {
  const state = useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getSnapshot, workspaceStore.getSnapshot)
  const [sourceText, setSourceText] = useState('')
  const [topic, setTopic] = useState('Fractions & decimals')
  const [instruction, setInstruction] = useState('')
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState('')
  const [agentError, setAgentError] = useState('')
  const [pendingOperation, setPendingOperation] = useState<{ kind: 'draft' | 'agent' | 'swap'; questionId?: string } | null>(null)
  const [toolStatus, setToolStatus] = useState({ state: 'checking', count: 0, message: 'Checking WebMCP support…' })
  const fileInput = useRef<HTMLInputElement>(null)
  const snapshot = useMemo(() => evaluateConstraints(state.worksheet, state.constraints), [state.constraints, state.worksheet])

  const announcement = useMemo(() => {
    if (!state.hasDraft) return ''
    const needsAttention = [
      snapshot.time.status === 'needs-attention' ? 'completion time' : '',
      snapshot.reading.status === 'needs-attention' ? 'reading level' : '',
      snapshot.mix.status === 'needs-attention' ? 'question balance' : '',
      snapshot.coverage.status === 'needs-attention' ? 'standards coverage' : '',
    ].filter(Boolean)
    return needsAttention.length
      ? `Constraint checks updated. ${snapshot.satisfiedCount} of 4 satisfied. Needs attention: ${needsAttention.join(', ')}.`
      : 'Constraint checks updated. All four constraints are satisfied. This worksheet is ready for class.'
  }, [snapshot, state.hasDraft])

  const visibleAgentError = agentError || state.lastError

  useEffect(() => registerClassworkTools(setToolStatus), [])

  const addTypedSource = () => {
    try {
      setUploadError('')
      workspaceActions.addSourceMaterial(sourceText, 4, topic, 'Pasted lesson notes')
      setSourceText('')
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Could not add source material.')
    }
  }

  const uploadSource = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      setUploadError('')
      const dataUrl = await resizeImage(file)
      workspaceActions.addSourceMaterial(dataUrl, 4, topic, file.name)
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Could not add that image.')
    } finally {
      event.target.value = ''
    }
  }

  const generateDraft = () => {
    if (pendingOperation) return
    setUploadError('')
    setPendingOperation({ kind: 'draft' })
    window.setTimeout(() => {
      try {
        workspaceActions.generateDraft(undefined, 'agent')
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : 'Could not generate the draft.')
      } finally {
        setPendingOperation(null)
      }
    }, 260)
  }

  const submitInstruction = (event: FormEvent) => {
    event.preventDefault()
    if (pendingOperation) return
    const cleaned = instruction.trim()
    const target = /swap|replace|change/i.test(cleaned)
      ? state.worksheet.questions.find((question) => /fraction|\/10|\/100|denominator/i.test(question.prompt)) ?? state.worksheet.questions[0]
      : undefined
    setAgentError('')
    setPendingOperation(target ? { kind: 'swap', questionId: target.id } : { kind: 'agent' })
    window.setTimeout(() => {
      try {
        runAgentInstruction(cleaned)
        setInstruction('')
      } catch (error) {
        setAgentError(error instanceof Error ? error.message : 'The instruction could not be completed.')
      } finally {
        setPendingOperation(null)
      }
    }, 260)
  }

  const startDrag = (event: DragEvent<HTMLElement>, id: string) => {
    setDraggedId(id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }

  const dropAt = (event: DragEvent<HTMLElement>, index: number) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/plain') || draggedId
    if (id) workspaceActions.moveQuestion(id, index)
    setDraggedId(null)
  }

  const dropToDelete = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/plain') || draggedId
    if (id) workspaceActions.deleteQuestion(id)
    setDraggedId(null)
  }

  const selectedStandards = new Set(state.constraints.standards)
  const sourceGrounding = state.source
    ? sourceGroundingLabel(analyzeSourceMaterial(state.source))
    : ''

  return (
    <>
      <a className="skip-link" href="#worksheet-board">Skip to worksheet board</a>
      <div className="app-frame">
        <header className="topbar glass-base">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true"><FileText size={17} /></span>
            <div><strong>Classwork</strong><span>Grade 4 mathematics workspace</span></div>
          </div>
          <div className="topbar__actions">
            <span className="save-state"><Save size={14} /> Saved locally</span>
            <span className={`webmcp-state webmcp-state--${toolStatus.state}`} title={toolStatus.message}>
              <i aria-hidden="true" />
              {toolStatus.state === 'ready' ? `${toolStatus.count} tools connected` : toolStatus.state === 'unsupported' ? 'WebMCP browser required' : toolStatus.message}
            </span>
            <button type="button" className="button button--secondary" onClick={() => window.print()}><Printer size={15} /> Print worksheet</button>
          </div>
        </header>

        <main className="workspace-grid">
          <aside className="source-column" aria-label="Source material and worksheet settings">
            <section className="source-panel glass-raised">
              <div className="panel-heading">
                <div><p className="eyebrow">01 · Source</p><h2>Class material</h2></div>
                {state.source && <span className="panel-check" role="img" aria-label="Source added"><Check size={15} /></span>}
              </div>

              {state.source ? (
                <div className="source-preview">
                  {state.source.kind === 'image' ? <img src={state.source.content} alt={`Uploaded source: ${state.source.name}`} /> : (
                    <div className="source-note-preview"><FileText size={18} /><p>{state.source.content}</p></div>
                  )}
                  <div className="source-preview__meta"><strong>{state.source.name}</strong><span>{state.source.topic} · Grade {state.source.grade}</span><span>{sourceGrounding}</span></div>
                  <button type="button" className="text-button" onClick={() => fileInput.current?.click()}>Replace source</button>
                </div>
              ) : (
                <div className="source-empty">
                  <button type="button" className="upload-zone" onClick={() => fileInput.current?.click()}>
                    <span><ImagePlus size={19} /></span><strong>Choose a classroom photo</strong><small>Whiteboard, textbook, or old worksheet</small>
                  </button>
                  <div className="or-divider"><span>or paste notes</span></div>
                  <label className="field"><span>Source text</span><textarea value={sourceText} onChange={(event) => setSourceText(event.target.value)} rows={5} placeholder="Paste the concepts, examples, or directions students have already seen…" /></label>
                  <button type="button" className="button button--secondary button--full" onClick={addTypedSource} disabled={!sourceText.trim()}><Plus size={15} /> Add notes</button>
                  <button type="button" className="text-button text-button--center" onClick={() => workspaceActions.loadDemoSource()}>Use demo worksheet image</button>
                </div>
              )}
              <input ref={fileInput} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/svg+xml" onChange={uploadSource} aria-label="Upload source image" />
              {uploadError && <p className="form-error" role="alert">{uploadError}</p>}
            </section>

            <section className="settings-panel glass-raised">
              <div className="panel-heading"><div><p className="eyebrow">02 · Parameters</p><h2>Class fit</h2></div></div>
              <div className="fixed-scope"><div><span>Grade & subject</span><strong>Grade 4 · Mathematics</strong></div><LockKeyhole size={15} aria-label="Demo scope locked" /></div>
              <label className="field"><span>Topic</span><input value={topic} onChange={(event) => setTopic(event.target.value)} /></label>
              <div className="stepper-field">
                <div><span>Completion time</span><small>Independent practice</small></div>
                <div className="stepper">
                  <button type="button" onClick={() => workspaceActions.setConstraints({ timeLimit: Math.max(5, state.constraints.timeLimit - 5) })} aria-label="Decrease time limit"><Minus size={14} /></button>
                  <output>{state.constraints.timeLimit}<small> min</small></output>
                  <button type="button" onClick={() => workspaceActions.setConstraints({ timeLimit: Math.min(45, state.constraints.timeLimit + 5) })} aria-label="Increase time limit"><Plus size={14} /></button>
                </div>
              </div>
              <div className="reading-target"><span>Reading target</span><strong>Grade 4 <small>± 0.7</small></strong></div>
              <fieldset className="standards-fieldset">
                <legend>Required standards</legend>
                {STANDARD_LIBRARY.map((standard) => (
                  <label key={standard.id}>
                    <input type="checkbox" checked={selectedStandards.has(standard.id)} onChange={(event) => {
                      const standards = event.target.checked ? [...state.constraints.standards, standard.id] : state.constraints.standards.filter((id) => id !== standard.id)
                      if (standards.length) workspaceActions.setConstraints({ standards })
                    }} />
                    <span className="custom-check" aria-hidden="true"><Check size={12} /></span>
                    <span><strong>{standard.id}</strong><small>{standard.short}</small></span>
                  </label>
                ))}
              </fieldset>
              <div className="mix-target"><span>Question mix</span><div><b>40</b><b>40</b><b>20</b></div><small><span>MC</span><span>Short</span><span>Extended</span></small></div>
              <button type="button" className="button button--primary button--full" onClick={generateDraft} disabled={!state.source || Boolean(pendingOperation)}><WandSparkles size={16} /> {pendingOperation?.kind === 'draft' ? 'Generating draft…' : state.hasDraft ? 'Regenerate draft' : 'Generate draft'}</button>
            </section>
          </aside>

          <section id="worksheet-board" className="worksheet-board glass-base" aria-label="Editable worksheet board">
            <div className="board-toolbar">
              <div><p className="eyebrow">Shared worksheet board</p><span>{state.hasDraft ? `${state.worksheet.questions.length} questions · editing live` : 'Add a source to begin'}</span></div>
              {state.hasDraft && <button type="button" className="button button--quiet" onClick={() => workspaceActions.addQuestion()}><Plus size={15} /> Add question</button>}
            </div>

              {state.hasDraft ? (
                <div className="worksheet-sheet">
                <div className="worksheet-title-block">
                  <span>Independent practice</span>
                  <input value={state.worksheet.title} onChange={(event) => workspaceActions.setWorksheetTitle(event.target.value)} aria-label="Worksheet title" />
                  <p>{state.worksheet.subtitle} · Name ____________________ · Date __________</p>
                </div>
                <div className="question-list">
                  {state.worksheet.questions.map((question, index) => (
                    <QuestionCard key={question.id} question={question} index={index} total={state.worksheet.questions.length} dragging={draggedId === question.id} pending={pendingOperation?.kind === 'draft' || (pendingOperation?.kind === 'swap' && pendingOperation.questionId === question.id)} onDragStart={startDrag} onDragEnd={() => setDraggedId(null)} onDropAt={dropAt} />
                  ))}
                </div>
                <div className={`delete-dropzone ${draggedId ? 'delete-dropzone--active' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={dropToDelete} aria-hidden={!draggedId}>
                  <Trash2 size={16} /><span>{draggedId ? 'Drop here to remove from the worksheet' : 'Drag a question here to remove it'}</span>
                </div>
              </div>
            ) : (
              <div className="board-empty">
                <div className="board-empty__illustration" aria-hidden="true"><span /><span /><span /></div>
                <div><h1>Build from what students already saw.</h1><p>Add a classroom photo or paste lesson notes. Classwork will draft inside the time, reading, question-mix, and standards constraints you set.</p></div>
                <button type="button" className="button button--secondary" onClick={() => fileInput.current?.click()}><Camera size={16} /> Add source material</button>
              </div>
            )}

            <section className="agent-console glass-floating" aria-label="Agent instruction console">
              <div className="agent-console__heading"><span className="agent-mark" aria-hidden="true"><Bot size={17} /></span><div><strong>Revision agent</strong><span>Uses the same tools and board state</span></div></div>
              <form onSubmit={submitInstruction}>
                <label className="sr-only" htmlFor="agent-instruction">Tell the agent what to change</label>
                <input id="agent-instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Swap the fractions question for something on decimals" />
                <button type="submit" className="send-button" disabled={!instruction.trim() || !state.hasDraft || Boolean(pendingOperation)} aria-label="Send instruction">{pendingOperation ? <LoaderCircle size={16} className="pending-spinner" /> : <Send size={16} />}</button>
              </form>
              {visibleAgentError ? <p className="agent-response agent-response--error" role="alert"><CircleAlert size={14} /> {visibleAgentError}</p> : state.lastAgentMessage ? <p className="agent-response"><Check size={14} /> {state.lastAgentMessage}</p> : <button type="button" className="agent-suggestion" onClick={() => setInstruction('Swap the fractions question for something on decimals')}>Try the demo instruction</button>}
            </section>
          </section>

          <aside className="constraint-column" aria-label="Live worksheet checks and activity">
            <ConstraintPanel snapshot={snapshot} hasDraft={state.hasDraft} />
            <section className="activity-panel glass-raised">
              <div className="panel-heading activity-heading">
                <div><p className="eyebrow">Shared history</p><h2>Activity</h2></div>
                {state.activity.length > 0 && <button type="button" className="icon-button" onClick={() => workspaceActions.reset()} aria-label="Reset demo workspace" title="Reset demo"><RotateCcw size={15} /></button>}
              </div>
              {state.activity.length ? (
                <ol className="activity-list">
                  {state.activity.slice(0, 5).map((item) => (
                    <li key={item.id}>
                      <span className={`activity-icon activity-icon--${item.actor}`} aria-hidden="true">{item.actor === 'agent' ? <Bot size={14} /> : item.actor === 'teacher' ? <UserRound size={14} /> : <MessageSquare size={14} />}</span>
                      <div><strong>{item.action}</strong><span>{item.detail}</span></div>
                      <time dateTime={item.createdAt}>{relativeTime(item.createdAt)}</time>
                    </li>
                  ))}
                </ol>
              ) : <p className="activity-empty">Direct edits and agent actions will appear together here.</p>}
            </section>
          </aside>
        </main>
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    </>
  )
}

export default App
