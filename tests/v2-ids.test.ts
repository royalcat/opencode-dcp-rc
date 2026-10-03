import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"

const root = mkdtempSync(join(tmpdir(), "dcp-v2-ids-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
test.after(() => rmSync(root, { recursive: true, force: true }))

// Persistence resolves its storage path when imported, after the test home is set.
const { Logger } = await import("../lib/logger")
const { createSessionState, resetSessionState } = await import("../lib/state")
const { assignMessageRefs, formatMessageRef, parseBoundaryId } = await import("../lib/message-ids")
const { injectMessageIds, prune, stripHallucinations } = await import("../lib/messages")
const { stripHallucinationsFromString } = await import("../lib/messages/utils")
const { PromptStore } = await import("../lib/prompts/store")
const { buildCompressedBlockGuidance } = await import("../lib/prompts/extensions/nudge")
const { createRcCompressTool } = await import("../lib/compress/rc")
const { wrapCompressedSummary } = await import("../lib/compress/state")
const logger = new Logger(false)

function config(): PluginConfig {
    return {
        compress: { permission: "allow", protectedTools: [], protectUserMessages: false },
        manualMode: { enabled: false, automaticStrategies: true },
        experimental: { allowSubAgents: false },
        turnProtection: { enabled: false, turns: 4 },
        strategies: { deduplication: { enabled: false }, purgeErrors: { enabled: false } },
        pruneNotification: "off",
        protectedFilePatterns: [],
    } as PluginConfig
}

function messages(sessionID: string): WithParts[] {
    return ["user", "assistant"].map((role, index) => ({
        info: {
            id: `msg_${index + 1}`,
            role,
            sessionID,
            agent: "build",
            model: { providerID: "lab", modelID: "test" },
            time: { created: index + 1 },
        },
        parts: [{ type: "text", text: `Original ${role} content` }],
    })) as WithParts[]
}

test("V2 IDs are unpadded, distinct from blocks, and survive state resets", () => {
    const state = createSessionState("compact")
    assignMessageRefs(state, messages("ses_ids"))
    assert.equal(state.messageIds.byRawId.get("msg_1"), "@1@")
    assert.equal(state.messageIds.byRef.get("@2@"), "msg_2")
    assert.deepEqual(parseBoundaryId("@4@", "compact"), {
        kind: "message",
        ref: "@4@",
        index: 4,
    })
    assert.deepEqual(parseBoundaryId("@b1@", "compact"), {
        kind: "compressed-block",
        ref: "@b1@",
        blockId: 1,
    })
    for (const invalid of ["4", "@04@", "@0@", "@-1@", "@1.5@", "m0004", "b1", ""]) {
        assert.equal(parseBoundaryId(invalid, "compact"), null, invalid)
    }
    assert.equal(formatMessageRef(10000, "compact"), "@10000@")
    state.messageIds.nextRef = 10000
    const later = messages("ses_ids")
    later[0]!.info.id = "msg_10000"
    assignMessageRefs(state, later)
    assert.equal(state.messageIds.byRawId.get("msg_10000"), "@10000@")
    resetSessionState(state)
    assignMessageRefs(state, messages("ses_reset"))
    assert.equal(state.messageIds.byRawId.get("msg_1"), "@1@")
    assert.equal(formatMessageRef(4), "m0004")
    assert.equal(parseBoundaryId("@4@"), null)
})

test("V2 cleans echoed IDs before injecting protected/message tags", () => {
    const state = createSessionState("compact")
    const raw = messages("ses_cleanup")
    raw[1]!.parts = [
        { type: "text", text: "It’s 2026.\n@99@" },
        {
            type: "tool",
            tool: "read",
            callID: "call_read",
            state: { status: "completed", input: {}, output: "Result @98@  " },
        },
    ] as WithParts["parts"]
    stripHallucinations(raw, state.idFormat)
    assert.equal((raw[1]!.parts[0] as any).text, "It’s 2026.\n")
    assert.doesNotMatch(JSON.stringify(raw), /@9[89]@/)

    const settings = config()
    settings.compress.protectUserMessages = true
    assignMessageRefs(state, raw)
    injectMessageIds(state, settings, raw)
    assert.match((raw[0]!.parts[0] as any).text, /@blocked@/)
    assert.match((raw[1]!.parts[1] as any).state.output, /@2@$/)
    assert.doesNotMatch(JSON.stringify(raw), /dcp-message-id/)

    assert.equal(
        stripHallucinationsFromString("mail a@b.com; version 4; [high]", "compact"),
        "mail a@b.com; version 4; [high]",
    )
})

test("V2 block guidance lists active blocks for rc merging", () => {
    const state = createSessionState("compact")
    state.prune.messages.activeBlockIds.add(2)
    const guidance = buildCompressedBlockGuidance(state)
    assert.match(guidance, /@b2@/)
    assert.match(guidance, /selection boundaries/)
})

test("V2 renders persisted summaries with the current markers", () => {
    const state = createSessionState("compact")
    const raw = messages("ses_stored")
    state.prune.messages.activeByAnchorMessageId.set("msg_1", 1)
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        active: true,
        anchorMessageId: "msg_1",
        summary: wrapCompressedSummary(1, "STORED"),
    } as any)
    prune(state, logger, raw)
    assert.match((raw[0]!.parts[0] as any).text, /STORED[\s\S]*@b1@$/)
    assert.doesNotMatch((raw[0]!.parts[0] as any).text, /dcp-message-id/)
})

test("V2 prompt defaults, schemas and reloads describe compact IDs", () => {
    const prompts = new PromptStore(logger, root, true, "compact")
    const defaults = join(process.env.OPENCODE_CONFIG_DIR!, "dcp-prompts", "defaults")
    assert.match(readFileSync(join(defaults, "compress-rc.md"), "utf8"), /@4@-@8@/)

    const tool = createRcCompressTool({
        client: {},
        state: createSessionState("compact"),
        config: config(),
        logger,
        prompts,
        generate: async () => "",
    })
    assert.match(tool.description, /@4@-@8@/)
    assert.doesNotMatch(tool.description, /mNNNN|m000\d|dcp-message-id|XML/)
    assert.match(tool.args.ids.description, /Each item becomes one summary/)

    const overrides = join(process.env.OPENCODE_CONFIG_DIR!, "dcp-prompts", "overrides")
    mkdirSync(overrides, { recursive: true })
    writeFileSync(join(overrides, "system.md"), "Custom system instruction")
    prompts.reload()
    assert.match(prompts.getRuntimePrompts().system, /Custom system instruction/)
    assert.match(prompts.getRuntimePrompts().compressRc, /Compress stale conversation messages/)
    rmSync(join(overrides, "system.md"))
})
