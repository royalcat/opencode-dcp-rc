# AGENTS.md

Working notes for agents and developers in this repository.

## Project

- `@royalcat/opencode-dcp-rc` is a fork of [DCP](https://github.com/Tarquinen/opencode-dynamic-context-pruning)
  (upstream v3.2.0, commit `f8232fde`), maintained by RoyalCat. Current version: **4.0.3**.
- `rc` = **RoyalCat** (fork owner initials). It is _not_ "release candidate": do not
  name versions `x.y.z-rc.N`.
- Purpose: Make a fully local OpenCode **V2** plugin, with the plugin's internals invisible to the user.
- The only user-visible artifact is the `compress` tool call.
- License: AGPL-3.0-or-later (inherited). Keep `LICENSE` and upstream attribution.
  The upstream README is appended below the fork section in `README.md`.
- `README.md` documents user-facing behavior only; implementation internals are
  documented here.

## Commands

```sh
npm install --legacy-peer-deps   # --legacy-peer-deps is required (OpenTUI peer versions)
npm test                          # unit tests (root + tests/logger workspace)
npm run typecheck
npm run build                     # clean + tsup + tsc declarations
npm run check:package             # build + package verification
npm run format:check
npm run lab:rc                    # Docker e2e against a mock LLM (see below)
```

CI (`.github/workflows/pr-checks.yml`) runs: `npm ci --legacy-peer-deps`, format
check, typecheck, build, test, `npm audit`.

## Where things live

| Area                                    | Path                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Plugin entry (V2 `{ id, setup }`)       | `index.ts`                                                                                |
| V2 plugin wiring (hooks, tool, rc)      | `lib/v2/index.ts`                                                                         |
| rc compress tool (selection-only)       | `lib/compress/rc.ts`                                                                      |
| rc summary prompt build/parse/serialize | `lib/compress/summary.ts`                                                                 |
| Hidden summary usage capture (V2)       | `lib/v2/usage.ts` (aisdk + http hooks, local estimates)                                   |
| Output scrubbing (V2 response side)     | `lib/v2/scrub.ts`                                                                         |
| Compression usage totals                | `lib/compress/usage.ts` (normalization, aggregation)                                      |
| Compression usage tests                 | `tests/compression-usage.test.ts`                                                         |
| Output scrub tests                      | `tests/output-scrub.test.ts`                                                              |
| rc tool description                     | `lib/prompts/compress-rc.ts` (+ `lib/prompts/store.ts`, `lib/prompts/extensions/tool.ts`) |
| Config loading/defaults                 | `lib/config.ts`, schema `dcp.schema.json`                                                 |
| Message ID formats                      | `lib/message-ids.ts`                                                                      |
| State persistence                       | `lib/state/`                                                                              |
| Protected content append helpers        | `lib/compress/protected-content.ts`                                                       |
| rc unit tests                           | `tests/rc.test.ts`                                                                        |
| E2E lab (mock LLM)                      | `tests/lab/` (`mock.mjs`, `rc-run.mjs`), runner `scripts/lab-rc.mjs`                      |
| Fork branding                           | `tui.tsx`, `lib/v2/rpc.ts`                                                                |

## How `rc` works (read before touching compression)

1. `session.hook("context")` (V2) injects the `compress` tool, message IDs, nudges and
   system prompt into the **outgoing copy only**. Stored history is never modified.
2. The model calls `compress` with `{"ids":["m0004-m0008","m0011"]}` and nothing else —
   it does not write summaries. Selectors may be message IDs, block IDs (`bN`), or
   inclusive ranges of either, in either ID format (`mNNNN`/`bN` XML or `@N@`/`@bN@`
   compact); they are normalized internally.
3. `lib/compress/rc.ts` resolves the selectors, validates non-overlap and block
   coverage, then performs a hidden **synchronous** `ctx.session.generate()` carrying
   the marker `[[DCP-RC-SUMMARY:<callId>]]` (the call id attributes provider telemetry
   back to the request). There is no deferred/idle path: if generation
   fails, the tool call fails and the selection stays untouched.
4. `session.hook("generate")` in `lib/v2/index.ts` detects the marker and strips the
   session message context **and all tools** from that transient request. The host
   system prompt remains attached (byte-identical prefix of the main request, so
   providers with prefix caching reuse it). Keep this invariant: the hidden request's
   message context must contain only the selected segments plus formatting
   instructions.
5. The reply is parsed into `SLEEV-SUMMARY <selector>` sections, protected content
   (`compress.protectedTools`, `compress.protectedFilePatterns`,
   `compress.protectTags`) is appended, and the results are applied to state and
   persisted; later context hooks replace those messages in outgoing requests.
6. Selections may include active compressed blocks. Their summaries are embedded in the
   hidden prompt as prior summaries, the new block consumes them, and the old blocks
   are deactivated. A selection may not partially cover a block (include the block's
   anchor).
7. `protectUserMessages` marks user messages as `BLOCKED`: they get no visible ref,
   cannot be boundaries, and are excluded from coverage and from the hidden prompt.
8. Invisibility invariants (design goal, not configurable): transforms apply to the
   outgoing copy only; injected metadata (ID tags, nudges, summary prompt, markers)
   never enters stored history or user-visible output. The `compress` tool call and
   its result (the model's selectors, e.g. `Compressed: m0004-m0008.`) are the one
   intended user-visible artifact. Notifications are independent and opt-in
   (`pruneNotification`, default `off`).
9. OpenCode V2 is required (`@opencode/plugin` ^2.0.22, verified on 2.0.4). V1 support
   and the upstream `range`/`message` modes were removed in 4.0.0.
10. Token usage of the hidden requests is accounted for in stats: provider telemetry when
    available, otherwise a local tokenizer estimate. `lib/v2/usage.ts` captures provider
    usage through two paths: the `aisdk.language` hook (wraps the resolved language model
    and reads AI SDK v3 usage from `doStream`/`doGenerate`) for AI SDK provider packages,
    and the `http.response` hook (parses the raw body of `kind === "generate"` requests)
    for native `@opencode/ai/providers/*` packages. Attribution goes through the call id
    in the marker (`[[DCP-RC-SUMMARY:<callId>]]`): the tracker
    (`createCompressionUsageTracker`) is created once per plugin setup,
    `recordEstimatedInput` stores the generate-hook prompt estimate, and
    `resolve(callId, text)` prefers provider telemetry, falling back to that estimate.
    Registering the http hook makes core buffer and wrap every HTTP call for the
    provider, so its callback must return immediately for non-`generate` kinds and never
    throw. Parsers: `parseProviderUsageFromBody` (`lib/v2/usage.ts`) handles JSON and SSE
    bodies for OpenAI Responses/Chat, Anthropic (cache read/write, exclusive input) and
    Google `usageMetadata`; `normalizeProviderUsage` (`lib/compress/usage.ts`) handles
    the AI SDK v3 shape. Totals (`CompressionUsageTotals`) live in
    `SessionStats.compressionUsage` (session and all-time) and are surfaced by
    `/dcp stats` and the TUI Stats panel. Both paths are best-effort: registration,
    wrapping or parsing failures fall back silently to estimates, so never let them
    break a request.
11. Response scrubbing lives in `lib/v2/scrub.ts`. Models sometimes echo injected
    reminders or ID tags into visible replies; the plugin wraps model responses and
    removes those echoes before OpenCode stores or displays them. SSE/JSON bodies on
    the `http.response` hook (OpenAI Responses/Chat, Anthropic, Google) and AI SDK
    text/reasoning parts are covered; tool-call arguments are never touched.
    `compress.scrubModelOutput` / `compress.scrubMessageIds` (both default `true`)
    are kill-switches. Forward-only: existing stored copies are not rewritten, and
    WebSocket-transport providers are not covered.

## Fork conventions

- Config files are `dcp-rc.jsonc` / `dcp-rc.json` (global, `$OPENCODE_CONFIG_DIR`,
  project `.opencode/`). There is no `compress.mode` or `autoUpdate` key.
- Fork branding is limited to the package name `@royalcat/opencode-dcp-rc`, the RPC id
  `dcp-rc` (`lib/v2/rpc.ts`), the plugin ids (`index.ts`, `tui.tsx`), and the
  config file names. Slash commands (`/dcp`, `/dcp-compress`) and prompt overrides
  (`dcp-prompts/overrides/`, `lib/prompts/store.ts`) keep upstream names; there is
  no self-update.
- Keep upstream structure and file names where they still exist. Put fork-specific
  logic in `rc.ts`, `summary.ts`, and `compress-rc.ts`; avoid spreading rc branches
  through upstream modules.
- Do not rename upstream files or remove attribution. Keep AGPL headers.
- Version bumps: ask the owner. Pushes to `master` run
  `.github/workflows/publish.yml`: it skips when the version is already on npm,
  otherwise it runs checks and publishes with provenance through npm trusted
  publishing (configured on npmjs.com for `royalcat/opencode-dcp-rc` +
  `publish.yml`). `prepublishOnly` runs `check:package`; a manual publish needs
  `npm login` then `npm publish --access public`.

## Testing notes

- Unit tests use `node:test` via `tsx`: `node --import tsx --test tests/*.test.ts`.
- `npm run lab:rc` needs Docker image `dcp-lab:2.0.4` (built from
  `tests/lab/Dockerfile`: OpenCode V2 2.0.4). It builds and packs the fork, then runs
  `tests/lab/rc-run.mjs` against a mock provider inside the container. Result JSON
  looks like
  `{"mode":"rc","hiddenSummaryRequest":true,"compressionApplied":true,"summaryRequestHasNoTools":true,"outputScrubbed":true,...}`.
  Lab output goes to `/tmp/opencode/dcp-lab-rc/<timestamp>/`.
- `tests/compression-usage.test.ts` covers provider usage normalization
  (`normalizeProviderUsage`), HTTP body parsing (`parseProviderUsageFromBody`: OpenAI
  Responses/Chat SSE, Anthropic, Google, malformed/empty bodies), estimate fallback,
  totals aggregation, and backward-compatible persisted loads. `tests/rc.test.ts`
  covers the provider and estimated paths end to end, including retry accounting.
  The lab asserts provider-sourced usage (`input_tokens: 100`, `output_tokens: 5` per
  summary request from `tests/lab/mock.mjs`) persisted into `stats.compressionUsage`.
- `tests/output-scrub.test.ts` covers response scrubbing: cross-chunk tag and ID
  removal, provider payload shapes, SSE/JSON transforms, tool-argument immunity,
  aisdk parts, and the HTTP hook kill switch. The lab mock's default reply echoes a
  `dcp-system-reminder` block and a standalone message-ID line; `rc-run.mjs` asserts
  neither reaches CLI output or the second run's stored context.
- Environment gotcha: some agent tool-output displays strip `@N@` tokens. Verify IDs
  and values with `grep`/`xxd` instead of trusting rendered output.
- Known limitation kept in the fork: the V2 public plugin API does not support
  `compress.permission: "ask"`.
