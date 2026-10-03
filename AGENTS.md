# AGENTS.md

Working notes for agents and developers in this repository.

## Project

- `@royalcat/opencode-dcp-rc` is a fork of [DCP](https://github.com/Tarquinen/opencode-dynamic-context-pruning)
  (upstream v3.2.0, commit `f8232fde`), maintained by RoyalCat. Current version: **4.0.0**.
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
   the marker `[[DCP-RC-SUMMARY]]`. There is no deferred/idle path: if generation
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
  `{"mode":"rc","hiddenSummaryRequest":true,"compressionApplied":true,"summaryRequestHasNoTools":true,...}`.
  Lab output goes to `/tmp/opencode/dcp-lab-rc/<timestamp>/`.
- Environment gotcha: some agent tool-output displays strip `@N@` tokens. Verify IDs
  and values with `grep`/`xxd` instead of trusting rendered output.
- Known limitation kept in the fork: the V2 public plugin API does not support
  `compress.permission: "ask"`.
