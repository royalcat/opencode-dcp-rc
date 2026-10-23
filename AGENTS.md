# AGENTS.md

Working notes for agents and developers in this repository.

## Project

- `@royalcat/opencode-dcp-rc` is a fork of [DCP](https://github.com/Tarquinen/opencode-dynamic-context-pruning)
  (upstream v3.2.0, commit `f8232fde`), maintained by RoyalCat. Current version: **4.3.0**.
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
| Selection resolution / boundary errors  | `lib/compress/search.ts`                                                                  |
| rc summary prompt build/parse/serialize | `lib/compress/summary.ts`                                                                 |
| `/dcp-compress` snippet                 | `lib/commands/manual.ts` (prompt only; no trigger state)                                  |
| Hidden summary usage capture (V2)       | `lib/v2/usage.ts` (aisdk + http hooks, local estimates)                                   |
| Output scrubbing (V2 response side)     | `lib/v2/scrub.ts`                                                                         |
| Compression usage totals                | `lib/compress/usage.ts` (normalization, aggregation)                                      |
| Compression usage tests                 | `tests/compression-usage.test.ts`                                                         |
| Output scrub tests                      | `tests/output-scrub.test.ts`                                                              |
| Stealth config + resolver tests         | `tests/stealth.test.ts`                                                                   |
| Injected system prompt                  | `lib/prompts/system.ts` (+ `lib/prompts/store.ts`, `lib/prompts/extensions/system.ts`)    |
| rc tool description                     | `lib/prompts/compress-rc.ts` (+ `lib/prompts/store.ts`, `lib/prompts/extensions/tool.ts`) |
| Config loading/defaults                 | `lib/config.ts`, schema `dcp.schema.json`                                                 |
| Message ID formats                      | `lib/message-ids.ts`                                                                      |
| State persistence                       | `lib/state/`                                                                              |
| Passive-mode override                   | `lib/passive-mode.ts` (state field in `lib/state/`, RPC `setPassive`)                     |
| `/dcp passive` handler                  | `lib/commands/passive.ts` (+ dispatch in `lib/hooks.ts`)                                  |
| Protected content append helpers        | `lib/compress/protected-content.ts`                                                       |
| rc unit tests                           | `tests/rc.test.ts`, `tests/modes.test.ts`                                                 |
| Passive command tests                   | `tests/passive-command.test.ts`, `tests/modes.test.ts`                                    |
| Passive session/cache tests             | `tests/passive-command-session.test.ts`                                                   |
| Passive persistence tests               | `tests/passive-persistence.test.ts`                                                       |
| E2E lab (mock LLM)                      | `tests/lab/` (`mock.mjs`, `rc-run.mjs`), runner `scripts/lab-rc.mjs`                      |
| Fork branding                           | `tui.tsx`, `lib/v2/rpc.ts`                                                                |

## How `rc` works (read before touching compression)

1. `session.hook("context")` (V2) injects the `compress` tool, message IDs, nudges and
   system prompt into the **outgoing copy only**. Stored history is never modified.
2. The model calls `compress` with `{"ids":["m0004-m0008","m0011"]}` and nothing else —
   it does not write summaries. Selectors may be message IDs, block IDs (`bN`), or
   inclusive ranges of either, in either ID format (`mNNNN`/`bN` XML or `@N@`/`@bN@`
   compact); they are normalized internally. Refs are monotonic per session and never
   reused, so reverted/deleted messages and BLOCKED user messages leave holes in the
   visible numbering; the model must not guess across a hole.
3. `lib/compress/rc.ts` resolves the selectors, validates non-overlap and block
   coverage, then performs a hidden **synchronous** `ctx.session.generate()` carrying
   the marker `[[DCP-RC-SUMMARY:<callId>]]` at the end of the prompt (detection scans
   the whole text; the stable prefix lets retried or repeated requests reuse provider
   prefix caching). The call id attributes provider telemetry back to the request.
   There is no deferred/idle path: if generation fails, the tool call fails and the
   selection stays untouched. Invalid boundaries fail before any request and return
   an actionable error: the reason (never assigned / removed from context / user
   message) plus the nearest selectable message refs and active block refs.
4. `session.hook("generate")` in `lib/v2/index.ts` detects the marker and strips the
   session message context from that transient request. The host system prompt remains
   attached (byte-identical prefix of the main request, so providers with prefix caching
   reuse it). Keep this invariant: the hidden request's message context must contain only
   the selected segments plus formatting instructions. The **tool set must not be
   stripped**: the hidden request carries the session's own tool snapshot (captured in the
   `context` hook per `sessionID` in `sessionTools`), because OpenCode's Zen free tier
   classifies a tool-less request as coming from outside OpenCode and answers it with
   `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`. Tools
   stay invisible to the user either way (the hidden request is never stored or shown).
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
8. Modes: `enabled: false` is Off (no tool, nudges, or strategies);
   `enabled: true` is Free (tool always available, nudges on). `passiveMode: true`
   keeps the tool but suppresses every nudge; dedup/purge still follow
   `strategies.*.enabled`, and the base system prompt keeps its compression
   guidance. `/dcp-compress` is only a prompt snippet asking the model to compress —
   it carries no trigger state and imposes no per-turn call limit. The compress tool
   is never gated by mode. 4.2.0 removed the old manual-mode state machine:
   `manualMode.*` config, `compress-pending`, `/dcp manual`, and the `manual` RPC
   method no longer exist (old configs get an unknown-key toast; use
   `passiveMode: true` for the previous "compression without nudges" behavior).
   The RPC snapshot now exposes `passiveMode` instead of `manualMode`. The removed
   gate also fixed a dead end: a cheap validation failure used to consume the manual
   trigger, so the model's corrected retry was rejected with "compress blocked" and
   cost a full-context round trip. Passive mode can also be overridden per session at
   runtime (`/dcp passive on|off|reset`, DCP panel row, RPC `setPassive`). The
   override lives in the session's DCP state, never edits stored messages, and only
   changes nudge injection on the next context hook; `reset` returns to config and
   new sessions start from config.
9. Invisibility invariants: transforms apply to the outgoing copy only; injected
   metadata (ID tags, nudges, summary prompt, markers) never enters stored history
   or user-visible output. The `compress` tool call and its result (the model's
   selectors, e.g. `Compressed: m0004-m0008.`) are the one intended user-visible
   artifact. Notifications are independent and opt-in (`pruneNotification`, default
   `off`). The cleanup layer is configurable through `stealth.enabled` (default
   `true`); injection itself is not configurable.
10. OpenCode V2 is required (`@opencode/plugin` ^2.0.22, verified on 2.0.4). V1 support
    and the upstream `range`/`message` modes were removed in 4.0.0.
11. Token usage of the hidden requests is accounted for in stats: provider telemetry when
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
12. Response scrubbing lives in `lib/v2/scrub.ts`. Models sometimes echo injected
    reminders or ID tags into visible replies; the plugin wraps model responses and
    removes those echoes before OpenCode stores or displays them. SSE/JSON bodies on
    the `http.response` hook (OpenAI Responses/Chat, Anthropic, Google) and AI SDK
    text/reasoning parts are covered; tool-call arguments are never touched.
    `stealth.enabled` (master, default `true`) gates both halves: response
    scrubbing via `stealth.scrubModelOutput` / `stealth.scrubMessageIds` (both
    default `true`) and the request-side `stripHallucinations` pass. The legacy
    `compress.scrubModelOutput` / `compress.scrubMessageIds` keys are deprecated
    aliases; new keys win in the same config layer. Forward-only: existing stored
    copies are not rewritten, and WebSocket-transport providers are not covered.

13. Prompt text lives in `lib/prompts/`: `system.ts` (system prompt, injected on every
    request), `compress-rc.ts` (the rc `compress` tool description), the `*-nudge.ts`
    files, and `extensions/` (subagent system addendum). `lib/prompts/store.ts`
    selects bundled vs override text and exposes `RuntimePrompts`; `rc.ts` registers
    `runtimePrompts.compressRc` as the tool description.
14. `system.ts` and `compress-rc.ts` both carry the intentional compress-timing
    guidance: compress right after a user message that opens new work, when earlier
    ranges are clearly closed; do **not** treat compression as an end-of-task tidy-up
    when no follow-up is expected (a summary with no later request to serve is
    wasted). This is why `turn-nudge.ts` fires at user turns over `minContextLimit`.
    `tests/prompts.test.ts` asserts the guidance with non-pinning regexes; keep the
    wording selection-only (the model passes IDs, never summaries).

## Explore later

Open items from the 2026-10-13 compression-cost investigation (a live 4-selector
compression billed 3 × ~149K-token hidden requests). Only the callId marker placement
was fixed; the rest is deliberately deferred.

- **Retry re-sends the whole batch.** `generateSummaries` (hardcoded 2 retries) re-sends
  every selector when a reply parses into no sections, so a format-failing model triples
  the request cost. Consider logging a bounded reply preview (debug) on missing/empty
  sections to learn why parsing failed, and tolerating common header variants that
  currently fail: en/em dash (`–`), spaces around the range separator, `SLEEV-SUMMARY:`
  with a colon, bold/backticked/quoted headers.
- **Reasoning inflation.** `serializeMessageForSummary` embeds stored `[reasoning]` parts
  (31.4K of a 115.4K batch in the observed case) while `block.compressedTokens` excludes
  them, so panels understate the hidden request. Candidate: `compress.includeReasoning`
  (default true, skip reasoning when off).
- **Per-run usage reporting.** Only session/all-time `compressionUsage` totals persist;
  recording each compress run's usage (calls/in/out/reasoning/cache) on its blocks would
  let the OpenChamber stats extension show the real request cost next to per-block
  estimates.
- **Caching check.** After the marker move, a retried compression should show large
  `cacheReadTokens` relative to `inputTokens` in `/dcp stats` (before the move:
  7,680 of 452,540).

## Fork conventions

- Config files are `dcp-rc.jsonc` / `dcp-rc.json` (global, `$OPENCODE_CONFIG_DIR`,
  project `.opencode/`). There is no `compress.mode` or `autoUpdate` key.
- Since 4.2.0 the only mode config keys are top-level `enabled` (Off/Free) and
  `passiveMode` (suppress nudges, keep the tool). Do not reintroduce `manualMode`
  or the old per-turn manual trigger state; the intentional session-scoped passive
  override lives in `lib/passive-mode.ts` and never edits session messages.
- The override is also exposed over OpenCode's RPC as
  `POST /api/rpc/dcp-rc/setPassive` with `{ sessionID, mode: "on" | "off" | "reset" }`
  and Basic auth `opencode:$OPENCODE_SERVER_PASSWORD`. The OpenChamber extension
  cannot call it yet: its guest `host.request` is origin-restricted and its local
  service does not receive the OpenCode URL/password. Wiring that panel needs either
  an OpenChamber host API or a file-based bridge.
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
  `{"mode":"rc","hiddenSummaryRequest":true,"compressionApplied":true,"summaryRequestHasTools":true,"outputScrubbed":true,...}`.
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
  aisdk parts, and the HTTP hook kill switch. `tests/stealth.test.ts` covers the
  `stealth` config layer: defaults, legacy alias mapping and precedence,
  deprecation detection, type validation, and the master gate for output scrubbing
  plus request-side echo stripping. The lab mock's default reply echoes a
  `dcp-system-reminder` block and a standalone message-ID line; `rc-run.mjs` asserts
  neither reaches CLI output or the second run's stored context.
- `tests/modes.test.ts` (replaces `manual-free-mode.test.ts` and
  `finalize-session.test.ts`) covers the mode matrix: Free fires nudges (positive
  control), Passive suppresses them and clears anchors, Passive still runs
  deduplication/purge, no manual prompt extensions remain, and `prepareSession`
  works with no trigger state. `tests/rc.test.ts` also covers consecutive compress
  calls and the boundary-error guidance (never assigned / removed / user message,
  nearest refs).
- `tests/passive-command.test.ts` covers `/dcp passive` parsing and state changes;
  `tests/passive-command-session.test.ts` asserts the command never prompts the
  session or edits messages; `tests/passive-persistence.test.ts` covers the
  persisted override round-trip.
- Environment gotcha: some agent tool-output displays strip `@N@` tokens. Verify IDs
  and values with `grep`/`xxd` instead of trusting rendered output.
- Known limitation kept in the fork: the V2 public plugin API does not support
  `compress.permission: "ask"`.
