# Small Model

Background generation for OpenChamber features uses the running OpenCode 2.x
instance. OpenChamber never talks to a provider directly and never reads or
stores provider credentials.

## Runtime boundary

- `client.js` builds an `@opencode/client` per call from the current runtime URL
  and auth headers. It URI-encodes the optional `x-opencode-directory` header
  and keeps a short, directory-scoped model-list cache.
- `index.js` resolves an enabled small model from OpenCode's model and provider
  lists, then calls `client.generate.text`. In OpenCode 2.0.12 that SDK method
  sends `POST /api/experimental/generate`.
- `routes.js` exposes OpenChamber's authenticated `GET /api/small-model` and
  `POST /api/small-model/generate` routes. The latter accepts the prompt,
  optional system text, model and directory hints, and returns the resolved
  provider/model with generated text.

## Model selection and limits

An explicit request model wins, followed by the OpenChamber override, an
enabled small model from the preferred provider, an enabled small model from
another provider, and OpenCode's default model. Provider availability comes
from OpenCode; failures are not converted into an authoritative empty catalog.

Generation clamps input to the resolved model's context limit after reserving
the requested output budget. `onOverflow: 'truncate'` reports
`inputTruncated`; `onOverflow: 'error'` returns `context-too-small`. Structured
output is requested as an instruction in the prompt because the OpenCode
generate endpoint has no structured-output parameter.

`call.js`, direct provider requests, catalog fallbacks, and provider credential
handling were v1-only code paths and are intentionally absent. Keep new calls
on the OpenCode SDK boundary in `client.js`/`index.js`.
