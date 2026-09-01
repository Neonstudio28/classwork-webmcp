# Contributing

## Local workflow

1. Install dependencies with `npm install`.
2. Run the full local stack with `npm run dev:full`.
3. Run `npm test`, `npm run lint`, and `npm run build` before submitting a change.

## WebMCP changes

Keep registered tool schemas, server authorization, and the visible worksheet state aligned. Mutations should flow through the shared workspace store so teacher edits and agent edits remain consistent.

## Pull requests

Explain the user-facing behavior, include verification steps, and call out any changes to source handling, browser support, or deployment configuration.
