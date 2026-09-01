# Testing Notes

Run the complete verification set before release:

```bash
npm test
npm run lint
npm run build
```

For WebMCP work, verify both paths: direct teacher edits and agent mutations. Confirm that each mutation updates the shared workspace, reruns the four constraint checks, and leaves the visible state consistent with `read_workspace_state()`.

For deployment changes, also verify the local API, production build, and the documented fallback behavior when Gemini is disabled.
