# Classwork

Classwork is a live worksheet constraint-checker for the OpenAI WebMCP Challenge. A Grade 4 mathematics teacher and an agent co-build one worksheet from classroom material while four live checks keep the result honest: completion time, reading level, question-type balance, and standards coverage.

The worksheet is not “done” when text exists. It is done when all four checks pass.

## Live deployment

[Open Classwork on Cloudflare](https://classwork-webmcp.hulking-arrow.workers.dev/)

This URL was deployed and exercised in ChatGPT’s in-app browser. It currently uses Cloudflare’s temporary preview account; redeploy from an authenticated Cloudflare account for a durable hackathon submission URL.

## Demo

The repository includes a concise browser-recorded demo at [`demo/classwork-demo.mp4`](./demo/classwork-demo.mp4), its final ready-state frame at [`demo/final-ready-state.png`](./demo/final-ready-state.png), and a short presenter script at [`demo/DEMO_SCRIPT.md`](./demo/DEMO_SCRIPT.md).

1. Add a classroom photo or use the included Grade 4 fractions-and-decimals worksheet sample.
2. Keep the scope at Grade 4 mathematics and the time limit at 15 minutes.
3. Generate the draft. It intentionally opens at **2/4 checks satisfied**: time and question balance need attention.
4. Drag the final extended-response question to the removal tray, or change its type with the keyboard-accessible controls. The instrument panel recalculates immediately.
5. Tell the revision agent: **“Swap the fractions question for something on decimals.”** The same board updates through the `swap_question` handler.
6. End on **4/4 — Ready for class**.

Closing line for the demo video:

> This isn't AI writing your worksheet — it's making sure the one you build together actually fits your class.

## Why WebMCP specifically

A normal chat window can suggest worksheet text, but it cannot reliably maintain a structured, page-scoped model of question IDs, response types, ordering, standards tags, and teacher edits. Classwork’s four `check_*` tools need live structured access to the worksheet that is actually visible—not a stale copy pasted into chat.

WebMCP gives the agent imperative tools bound to the current document. A teacher can rewrite, reorder, or remove a question directly while an agent can edit or swap a question through a registered tool; both paths mutate the same localStorage-backed store and rerun the same constraint functions. The agent therefore reasons about the teacher’s current worksheet instead of reconstructing it from conversation history.

### Browser support for the agent path

Using Classwork's agent-editing and `check_*` tool-calling path currently requires a WebMCP-enabled browser: ChatGPT's in-app browser, or Chrome with the experimental WebMCP flag enabled. Regular Chrome without that flag, Safari, and Firefox do not currently expose the imperative `document.modelContext` API, so they can use the complete teacher-facing editor but cannot invoke the WebMCP agent tools.

## Registered WebMCP tools

All tools are registered client-side with `document.modelContext.registerTool()` and cleaned up with an `AbortSignal`.

| Tool | Mode | Visible effect |
| --- | --- | --- |
| `add_source_material(image_or_text, grade, topic)` | Stage | Adds source material to the source panel |
| `generate_draft(constraints)` | Complete | Generates the six-question first draft |
| `edit_question(id, changes)` | Mutate | Rewrites or retags one visible question |
| `swap_question(id, reason)` | Mutate | Replaces one question in place |
| `check_time_estimate(worksheet)` | Read | Returns heuristic completion minutes |
| `check_reading_level(worksheet)` | Read | Returns a sentence/vocabulary grade estimate |
| `check_question_mix(worksheet)` | Read | Tallies response types against 40/40/20 |
| `check_standard_coverage(worksheet, standards)` | Read | Returns hit and missing standard IDs |

The read tools accept either the literal string `"current"` or a structured worksheet object. Mutating tools return only after the shared store and visible UI have updated.

## Demo scope

- Subject: Grade 4 mathematics
- Topic: fractions and decimals
- Standards: CCSS `4.NF.C.5`, `4.NF.C.6`, and `4.NF.C.7`
- Default time limit: 15 minutes
- Target question mix: 40% multiple choice, 40% short answer, 20% extended response

The narrow scope is deliberate. It lets the demo show a credible fractions-to-decimals revision without pretending to support every grade and subject.

## Constraint heuristics

- **Time:** response-mode base time plus a reading-word allowance; a worksheet passes when it uses 70–100% of the available class window.
- **Reading:** a transparent estimate based on average sentence length and the share of words with eight or more letters; Grade 4 passes within ±0.7 grade.
- **Question mix:** live type counts compared with the 40/40/20 target, with a 10-point tolerance.
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

```bash
npm install
npm run dev
```

Production verification:

```bash
npm run lint
npm run build
npm run preview
```

Open the page in a browser that implements the imperative WebMCP API. Unsupported browsers still get the complete teacher-facing editor; the header explains that browser tools require WebMCP support.

## Architecture

```text
src/
├── App.tsx             UI, keyboard/drag editing, upload handling, live region
├── App.css             tokens and three-tier glass material system
├── worksheet.ts        domain types, draft content, four pure checks
├── workspaceStore.ts   immutable external store + localStorage + activity log
└── webmcp.ts           schemas, handlers, and all eight tool registrations
```

There is no backend and no hidden worksheet copy. `workspaceStore.ts` is the single source of truth for the page, direct edits, and WebMCP actions.

## Netlify deployment

The included `netlify.toml` builds with `npm run build`, publishes `dist`, adds conservative security headers, and supplies the SPA fallback.

## License

[MIT](./LICENSE)
