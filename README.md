# Classwork

Classwork is a live worksheet constraint-checker for the OpenAI WebMCP Challenge. A teacher chooses a grade, subject, topic, standards, time window, reading target, and question mix; the teacher and an agent then co-build one source-grounded worksheet while four live checks keep the result honest.

The worksheet is not “done” when text exists. It is done when all four checks pass.

## Runtime status

The complete frontend, local API, and SQLite database run with `npm run dev:full`. The former temporary Cloudflare preview is not a durable deployment and should not be submitted as the final URL.

## Demo

The repository includes a concise browser-recorded demo at [`demo/classwork-demo.mp4`](./demo/classwork-demo.mp4), its final ready-state frame at [`demo/final-ready-state.png`](./demo/final-ready-state.png), and a short presenter script at [`demo/DEMO_SCRIPT.md`](./demo/DEMO_SCRIPT.md).

1. Choose any grade from 1–12, enter a subject and topic, and add curriculum or district standard IDs.
2. Paste classroom notes or upload an image. Gemini vision reads uploaded image bytes directly; the extracted evidence remains available for optional teacher review.
3. Generate a six-question draft grounded in that source. When the server is configured, Gemini creates the structured draft; otherwise Classwork clearly labels its deterministic local fallback.
4. Drag the final extended-response question to the removal tray, or change its type with the keyboard-accessible controls. The instrument panel recalculates immediately.
5. Tell the revision agent what concept to swap or ask it to shorten the worksheet. The same board updates through the registered WebMCP handler.
6. End on **4/4 — Ready for class**.

Closing line for the demo video:

> This isn't AI writing your worksheet — it's making sure the one you build together actually fits your class.

## Why WebMCP specifically

A normal chat window can suggest worksheet text, but it cannot reliably maintain a structured, page-scoped model of question IDs, response types, ordering, standards tags, and teacher edits. Classwork’s four `check_*` tools need live structured access to the worksheet that is actually visible—not a stale copy pasted into chat.

WebMCP gives the agent imperative tools bound to the current document. A teacher can rewrite, reorder, or remove a question directly while an agent can edit or swap a question through a registered tool; both paths mutate the same persisted workspace and rerun the same constraint functions. The read-only `read_workspace_state` tool exposes the live grade, subject, topic, source, stable question IDs, constraints, and results, so the agent reasons about the teacher’s current worksheet instead of guessing from the DOM.

### Browser support for the agent path

Using Classwork's agent-editing and `check_*` tool-calling path currently requires a WebMCP-enabled browser: ChatGPT's in-app browser, or Chrome with the experimental WebMCP flag enabled. Regular Chrome without that flag, Safari, and Firefox do not currently expose the imperative `document.modelContext` API, so they can use the complete teacher-facing editor but cannot invoke the WebMCP agent tools.

## Registered WebMCP tools

Classwork registers the eight challenge-required tools plus one read-only state tool client-side with `document.modelContext.registerTool()` and cleans them up with an `AbortSignal`.

| Tool | Mode | Visible effect |
| --- | --- | --- |
| `add_source_material(image_or_text, grade, subject, topic)` | Stage | Adds source material to the configurable workspace |
| `generate_draft(constraints)` | Complete | Generates the six-question first draft |
| `edit_question(id, changes)` | Mutate | Rewrites or retags one visible question |
| `swap_question(id, reason)` | Mutate | Generates and replaces one question in place through the same authorized server path |
| `read_workspace_state()` | Read | Returns source metadata, constraints, stable question IDs/content, and all four live checks |
| `check_time_estimate(worksheet)` | Read | Returns heuristic completion minutes |
| `check_reading_level(worksheet)` | Read | Returns a sentence/vocabulary grade estimate |
| `check_question_mix(worksheet)` | Read | Tallies response types against the live teacher-defined ratio |
| `check_standard_coverage(worksheet, standards)` | Read | Returns hit and missing standard IDs |

The four `check_*` tools accept either the literal string `"current"` or a structured worksheet object. Mutating tools return only after the shared store and visible UI have updated. `add_source_material` accepts pasted text or inline PNG/JPEG/WebP data (remote image URLs are rejected), plus optional `extracted_text`. For uploaded images, `generate_draft` sends the actual bytes to Gemini vision and stores its extracted evidence for teacher review. Clearly labelled local fallbacks are used only when Gemini is unavailable, times out, or reaches its configured quota; malformed model output still fails closed and is never committed.

## Configurable scope

- Grades 1–12
- Teacher-entered subject and topic
- Teacher-entered curriculum, state, district, or standards identifiers
- Editable completion time, reading target, and question-type ratio
- Source-grounded general drafting, with additional Grade 4 fractions/decimals handling when that material is actually supplied

## Constraint heuristics

- **Time:** response-mode base time plus a reading-word allowance; a worksheet passes when it uses 70–100% of the available class window.
- **Reading:** a transparent estimate based on average sentence length and the share of words with eight or more letters; the selected reading target passes within ±0.7 grade.
- **Question mix:** live type counts compared with the teacher-defined target, with a 10-point tolerance.
- **Standards:** requested identifiers compared with the `standardIds` attached to each question.

These checks are deterministic and inspectable. They are demo heuristics, not psychometric or curriculum-certification claims.

## Design system

The interface uses one cool-neutral surface, one muted sage accent, an 8px spacing rhythm, two radii, and three documented acrylic elevations:

| Tier | Opacity | Blur | Saturation | Use |
| --- | ---: | ---: | ---: | --- |
| Base | 46% white | 10px | 108% | Top bar and worksheet workspace |
| Raised | 72% white | 22px | 112% | Source, settings, constraints, activity |
| Floating | 88% white | 34px | 116% | Revision command console |

The CSS deliberately contains no page gradients, neon/glow effects, gradient text, icon drop-shadows, oversized hover scaling, or mixed icon sets.

## Accessibility

- Every question can be reordered with visible up/down buttons or `Alt + ArrowUp` / `Alt + ArrowDown` from its drag handle.
- Native drag-and-drop includes a dedicated removal tray.
- Constraint changes are announced through an atomic `aria-live="polite"` region.
- Focus indicators remain visible on glass surfaces.
- Text colors were selected for AA contrast against the most transparent local material; opacity is increased on denser panels rather than removing blur.
- Number motion respects `prefers-reduced-motion`.
- Print styles output the worksheet without editing chrome.

## Local development

Classwork sends the pasted source text—or, for an uploaded image, the resized image bytes—plus the visible generation constraints to Gemini only when the server operator explicitly enables it. Gemini is instructed to extract exact visible evidence before generating questions. The API key remains server-side and is never written to localStorage or SQLite. Gemini is requested with structured JSON output.

Copy `.env.example` to `.env.local`, add a project API key, and leave the explicit enable flag set:

```bash
CLASSWORK_AI_ENABLED=true
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-3.6-flash
```

Do not commit `.env.local`; `*.local` is ignored. If the key or enable flag is absent, worksheet generation still works through the source-grounded local fallback and the UI names that mode rather than claiming a Gemini call succeeded.

```bash
npm install
npm run dev:full
```

This starts the SQLite and generation API on `127.0.0.1:8787` and Vite on `127.0.0.1:5173`. Workspace state remains in the local SQLite database; when Gemini is enabled, only a generation request containing the reviewed source text and constraints leaves the machine. `npm start` builds and serves the production app and API together on port 8787.

Production verification:

```bash
npm test
npm run lint
npm run build
npm start
```

The local API accepts only loopback hosts and local browser origins, requires JSON for mutation bodies, limits request size and duration, and returns typed JSON errors for malformed or unknown API requests. Classroom images are limited to supported formats under 10 MB before browser decoding.

Open the page in a browser that implements the imperative WebMCP API. Unsupported browsers still get the complete teacher-facing editor; the header explains that browser tools require WebMCP support.

## Architecture

```text
src/
├── App.tsx             UI, keyboard/drag editing, upload handling, live region
├── App.css             tokens and three-tier glass material system
├── worksheet.ts        domain types, draft content, four pure checks
├── workspaceStore.ts   shared state + database/local persistence + activity log
├── workspaceApi.ts     same-origin workspace API client
└── webmcp.ts           schemas, handlers, eight required tools + workspace read
server/
└── index.mjs           local HTTP API, server-only Gemini generation, static frontend, and SQLite storage
```

`workspaceStore.ts` is the single state transition layer for direct edits and WebMCP actions. Every committed update is cached locally and persisted through the same-origin API to `data/classwork.sqlite` when the local backend is running.

## Netlify deployment

The included `netlify.toml` can still publish the standalone frontend, which falls back to browser storage when `/api` is unavailable. A production database deployment requires an explicitly selected and authorized server/database destination; classroom source material is not silently uploaded to a third party.

## License

[MIT](./LICENSE)
