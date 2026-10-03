import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import type { ToolContext } from "../lib/compress/types"
import type { CompressionUsage } from "../lib/compress/usage"

const root = mkdtempSync(join(tmpdir(), "dcp-rc-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
test.after(() => rmSync(root, { recursive: true, force: true }))

// Persistence resolves its storage path when imported, after the test home is set.
const { Logger } = await import("../lib/logger")
const { createSessionState } = await import("../lib/state")
const { PromptStore } = await import("../lib/prompts/store")
const { createRcCompressTool, parseSelector } = await import("../lib/compress/rc")
const {
    buildSummaryPrompt,
    parseSummarySections,
    restoreSummary,
    serializeMessageForSummary,
    buildSummaryMarker,
    extractSummaryCallId,
    hasSummaryMarker,
    RC_SUMMARY_MARKER,
} = await import("../lib/compress/summary")
const logger = new Logger(false)

function buildConfig(overrides: Partial<PluginConfig["compress"]> = {}): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 100000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            ...overrides,
        },
        strategies: {
            deduplication: { enabled: false, protectedTools: [] },
            purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        },
    } as PluginConfig
}

function buildRaw(sessionID: string): WithParts[] {
    const messages: Array<[string, string, string]> = [
        ["msg_u1", "user", "First question"],
        ["msg_a1", "assistant", "First answer"],
        ["msg_u2", "user", "Second question"],
        ["msg_a2", "assistant", "Second answer"],
    ]
    return messages.map(([id, role, text]) => ({
        info: {
            id,
            role,
            sessionID,
            agent: "build",
            model: { providerID: "lab", modelID: "test" },
            time: { created: 1 },
        },
        parts: [{ type: "text", text }],
    })) as WithParts[]
}

function defaultReply(prompt: string): string {
    const line = prompt.match(/RC-SELECTORS: ([^\n]+)/)?.[1] ?? ""
    const selectors = line
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    return selectors
        .map((selector) => `SLEEV-SUMMARY ${selector}\nSUMMARY ${selector}`)
        .join("\n\n")
}

let harnessCounter = 0

function createHarness(
    options: {
        raw?: WithParts[]
        config?: PluginConfig
        reply?: (prompt: string) => string
        generateError?: Error
        usage?: CompressionUsage
    } = {},
) {
    const sessionID = `ses_rc_${Date.now()}_${harnessCounter++}`
    const raw = options.raw ?? buildRaw(sessionID)
    const state = createSessionState("xml")
    const config = options.config ?? buildConfig()
    const prompts = new PromptStore(logger, root, false, "xml")
    const generateCalls: string[] = []
    const toasts: any[] = []
    const reply = options.reply ?? defaultReply

    const ctx: ToolContext = {
        client: {
            session: {
                messages: async () => ({ data: raw }),
                get: async () => ({ data: { parentID: null } }),
            },
            tui: {
                showToast: async (input: any) => {
                    toasts.push(input)
                },
            },
        },
        state,
        logger,
        config,
        prompts,
        generate: async ({ prompt }) => {
            generateCalls.push(prompt)
            if (options.generateError) {
                throw options.generateError
            }
            return { text: reply(prompt), usage: options.usage }
        },
    }
    const tool = createRcCompressTool(ctx)
    const run = {
        sessionID,
        messageID: "msg_compress",
        callID: "call_1",
        ask: async () => {},
        metadata() {},
    }
    return { ctx, state, config, tool, run, generateCalls, toasts, raw, sessionID }
}

test("rc selector parsing accepts message IDs, block IDs and ranges", () => {
    assert.deepEqual(parseSelector("m0004", "xml"), {
        selector: "m0004",
        startRef: "m0004",
        endRef: "m0004",
    })
    assert.deepEqual(parseSelector("m0004-m0008", "xml"), {
        selector: "m0004-m0008",
        startRef: "m0004",
        endRef: "m0008",
    })
    assert.deepEqual(parseSelector("b2", "xml"), {
        selector: "b2",
        startRef: "b2",
        endRef: "b2",
    })
    assert.deepEqual(parseSelector("m0004-b2", "xml"), {
        selector: "m0004-b2",
        startRef: "m0004",
        endRef: "b2",
    })
    assert.throws(() => parseSelector("m0008-m0004", "xml"), /start comes after end/)
    assert.throws(() => parseSelector("nonsense", "xml"), /Invalid selector/)
    assert.throws(() => parseSelector("m0001-", "xml"), /Invalid selector/)
    // Cross-format selectors are normalized to the session format.
    assert.equal(parseSelector("@4@", "xml").selector, "m0004")
    assert.equal(parseSelector("m0004", "compact").selector, "@4@")
})

test("rc summary prompt embeds the marker, selectors, segments and prior summaries", () => {
    const messages: WithParts[] = [
        {
            info: { id: "u1", role: "user" } as any,
            parts: [{ id: "u1:0", type: "text", text: "please fix the parser" } as any],
        },
        {
            info: { id: "a1", role: "assistant" } as any,
            parts: [
                { id: "a1:0", type: "text", text: "on it" } as any,
                {
                    id: "a1:1",
                    type: "tool",
                    tool: "read",
                    callID: "call1",
                    state: { status: "completed", input: { path: "/x.ts" }, output: "contents" },
                } as any,
            ],
        },
    ]

    const prompt = buildSummaryPrompt(
        [
            {
                selector: "m0004-m0005",
                messages,
                priorSummaries: [{ ref: "b1", body: "OLD SUMMARY BODY" }],
            },
        ],
        "xml",
    )
    assert.ok(prompt.startsWith(RC_SUMMARY_MARKER))
    assert.match(prompt, /SLEEV-SUMMARY m0004-m0005/)
    assert.match(prompt, /please fix the parser/)
    assert.match(prompt, /\[tool_call read\]/)
    assert.match(prompt, /\[tool_result read\]/)
    assert.match(prompt, /### b1 \(previous compressed summary\)/)
    assert.match(prompt, /OLD SUMMARY BODY/)
})

test("rc summary marker carries the hidden request call id", () => {
    assert.equal(buildSummaryMarker(), RC_SUMMARY_MARKER)
    assert.equal(buildSummaryMarker("c1"), "[[DCP-RC-SUMMARY:c1]]")
    assert.equal(hasSummaryMarker("[[DCP-RC-SUMMARY]]"), true)
    assert.equal(hasSummaryMarker("[[DCP-RC-SUMMARY:c1]]"), true)
    assert.equal(hasSummaryMarker("no marker here"), false)
    assert.equal(extractSummaryCallId("x [[DCP-RC-SUMMARY:c1]] y"), "c1")
    assert.equal(extractSummaryCallId("[[DCP-RC-SUMMARY]]"), undefined)
    assert.ok(buildSummaryPrompt([], "xml", "c1").startsWith("[[DCP-RC-SUMMARY:c1]]"))
})

test("rc records provider usage reported for the hidden requests", async () => {
    const usage: CompressionUsage = {
        inputTokens: 1200,
        outputTokens: 80,
        cacheReadTokens: 300,
        cacheWriteTokens: 0,
        reasoningTokens: 12,
        source: "provider",
    }
    const { state, tool, run } = createHarness({ usage })

    await tool.execute({ ids: ["m0001-m0002"] }, run as any)

    const totals = state.stats.compressionUsage
    assert.equal(totals.calls, 1)
    assert.equal(totals.providerCalls, 1)
    assert.equal(totals.estimatedCalls, 0)
    assert.equal(totals.inputTokens, 1200)
    assert.equal(totals.outputTokens, 80)
    assert.equal(totals.cacheReadTokens, 300)
    assert.equal(totals.reasoningTokens, 12)
})

test("rc falls back to local estimates when the generator reports no usage", async () => {
    const { state, tool, run } = createHarness()

    await tool.execute({ ids: ["m0001-m0002"] }, run as any)

    const totals = state.stats.compressionUsage
    assert.equal(totals.calls, 1)
    assert.equal(totals.providerCalls, 0)
    assert.equal(totals.estimatedCalls, 1)
    assert.ok(totals.inputTokens > 0)
    assert.ok(totals.outputTokens > 0)
})

test("rc summary parsing handles block selectors, missing, duplicates and empty bodies", () => {
    const text = [
        "SLEEV-SUMMARY m0001",
        "First summary.",
        "",
        "SLEEV-SUMMARY b2",
        "Block summary.",
        "",
        "SLEEV-SUMMARY m0002-m0003",
        "Second summary.",
        "",
        "SLEEV-SUMMARY m0002-m0003",
        "Duplicate ignored.",
        "",
        "SLEEV-SUMMARY m0004",
        "   ",
    ].join("\n")

    const parsed = parseSummarySections(
        text,
        ["m0001", "b2", "m0002-m0003", "m0004", "m0005"],
        "xml",
    )
    assert.deepEqual(
        parsed.sections.map((section) => section.selector),
        ["m0001", "b2", "m0002-m0003"],
    )
    assert.deepEqual(parsed.duplicates, ["m0002-m0003"])
    assert.deepEqual(parsed.empty, ["m0004"])
    assert.deepEqual(parsed.missing, ["m0005"])
})

test("rc summary parsing keeps multi-line bodies and normalizes ID formats", () => {
    const text = "SLEEV-SUMMARY m0001\nline one\nline two\n\nSLEEV-SUMMARY m0002\nother"
    const parsed = parseSummarySections(text, ["m0001", "m0002"], "xml")
    assert.equal(parsed.sections[0]?.summary, "line one\nline two")
    assert.equal(parsed.sections[1]?.summary, "other")

    const compact = parseSummarySections("SLEEV-SUMMARY @1@\nbody", ["m0001"], "compact")
    assert.deepEqual(
        compact.sections.map((section) => section.selector),
        ["@1@"],
    )
    const block = parseSummarySections("SLEEV-SUMMARY @b2@\nbody", ["b2"], "compact")
    assert.deepEqual(
        block.sections.map((section) => section.selector),
        ["@b2@"],
    )
})

test("rc message serialization keeps user text and tool state", () => {
    const message: WithParts = {
        info: { id: "u1", role: "user" } as any,
        parts: [
            { id: "p0", type: "text", text: "hello" } as any,
            { id: "p1", type: "text", text: "world" } as any,
        ],
    }
    const serialized = serializeMessageForSummary(message, "m0001")
    assert.match(serialized, /^### m0001 \(user\)/)
    assert.match(serialized, /hello\nworld/)
})

test("restoreSummary strips the block header and footer", () => {
    assert.equal(
        restoreSummary(
            "[Compressed conversation section]\nBODY\n\n<dcp-message-id>b2</dcp-message-id>",
        ),
        "BODY",
    )
    assert.equal(restoreSummary("plain summary"), "plain summary")
})

test("rc compression generates and applies summaries mid-turn", async () => {
    const { state, tool, run, generateCalls } = createHarness()
    const result = await tool.execute({ ids: ["m0001-m0002"] }, run as any)

    assert.equal(result, "Compressed: m0001-m0002.")
    assert.equal(generateCalls.length, 1)
    assert.match(generateCalls[0]!, /SLEEV-SUMMARY m0001-m0002/)

    const block = state.prune.messages.blocksById.get(1)
    assert.ok(block)
    assert.equal(block.active, true)
    assert.equal(block.mode, "rc")
    assert.equal(block.topic, "m0001-m0002")
    assert.match(block.summary, /SUMMARY m0001-m0002/)
    assert.deepEqual(state.prune.messages.byMessageId.get("msg_u1")?.activeBlockIds, [1])
    assert.deepEqual(state.prune.messages.byMessageId.get("msg_a1")?.activeBlockIds, [1])
    assert.equal(state.prune.messages.byMessageId.get("msg_u2"), undefined)
})

test("rc compression fails mid-turn without mutating state", async () => {
    const { state, tool, run } = createHarness({ generateError: new Error("boom") })
    state.manualMode = "compress-pending"

    await assert.rejects(tool.execute({ ids: ["m0001-m0002"] }, run as any), /boom/)

    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.prune.messages.activeBlockIds.size, 0)
    assert.notEqual(state.manualMode, "compress-pending")
})

test("rc applies partial summaries and reports the missing selectors", async () => {
    const { state, tool, run } = createHarness({
        reply: () => "SLEEV-SUMMARY m0001-m0002\nSUMMARY m0001-m0002",
    })
    const result = await tool.execute({ ids: ["m0001-m0002", "m0003-m0004"] }, run as any)

    assert.match(String(result), /^Compressed: m0001-m0002\./)
    assert.match(String(result), /Not compressed: m0003-m0004\./)
    assert.equal(state.prune.messages.blocksById.size, 1)
    // One initial attempt plus two retries for the missing selector.
    assert.equal(state.stats.compressionUsage.calls, 3)
    assert.equal(state.stats.compressionUsage.estimatedCalls, 3)
})

test("rc appends protected tool outputs to the generated summary", async () => {
    const sessionID = `ses_rc_tools_${Date.now()}`
    const raw = buildRaw(sessionID)
    raw[1]!.parts = [
        { type: "text", text: "First answer" },
        {
            type: "tool",
            tool: "task",
            callID: "call_task",
            state: { status: "completed", input: {}, output: "SUBAGENT_RESULT" },
        },
    ] as WithParts["parts"]
    const config = buildConfig({ protectedTools: ["task"] })
    const { state, tool, run } = createHarness({ raw, config })

    await tool.execute({ ids: ["m0002"] }, run as any)

    const block = state.prune.messages.blocksById.get(1)
    assert.ok(block)
    assert.match(block.summary, /SUBAGENT_RESULT/)
    assert.match(block.summary, /The following protected tools were used/)
})

test("rc never compresses protected user messages and rejects them as boundaries", async () => {
    const config = buildConfig({ protectUserMessages: true })
    const { state, tool, run } = createHarness({ config })

    await tool.execute({ ids: ["m0002-m0004"] }, run as any)

    const block = state.prune.messages.blocksById.get(1)
    assert.ok(block)
    assert.deepEqual(state.prune.messages.byMessageId.get("msg_u1")?.activeBlockIds ?? [], [])
    assert.deepEqual(state.prune.messages.byMessageId.get("msg_u2")?.activeBlockIds ?? [], [])
    assert.deepEqual(block.effectiveMessageIds, ["msg_a1", "msg_a2"])

    await assert.rejects(
        tool.execute({ ids: ["m0001"] }, run as any),
        /not available in the current conversation context/,
    )
})

test("rc consolidates existing blocks and feeds prior summaries to the hidden prompt", async () => {
    const { state, tool, run, generateCalls } = createHarness()

    await tool.execute({ ids: ["m0001-m0002"] }, run as any)
    const result = await tool.execute({ ids: ["m0001-m0004"] }, run as any)

    assert.equal(result, "Compressed: m0001-m0004.")
    const first = state.prune.messages.blocksById.get(1)
    const second = state.prune.messages.blocksById.get(2)
    assert.ok(first && second)
    assert.equal(first.active, false)
    assert.deepEqual(second.consumedBlockIds, [1])
    assert.deepEqual(second.effectiveMessageIds.sort(), ["msg_a1", "msg_a2", "msg_u1", "msg_u2"])
    assert.match(generateCalls[1]!, /### b1 \(previous compressed summary\)/)
    assert.match(generateCalls[1]!, /SUMMARY m0001-m0002/)
})

test("rc accepts a block ID as a selection boundary", async () => {
    const { state, tool, run, generateCalls } = createHarness()

    await tool.execute({ ids: ["m0001-m0002"] }, run as any)
    const result = await tool.execute({ ids: ["b1"] }, run as any)

    assert.equal(result, "Compressed: b1.")
    const first = state.prune.messages.blocksById.get(1)
    const second = state.prune.messages.blocksById.get(2)
    assert.ok(first && second)
    assert.equal(first.active, false)
    assert.deepEqual(second.consumedBlockIds, [1])
    assert.match(generateCalls[1]!, /### b1 \(previous compressed summary\)/)
})

test("rc preserves <protect> tags when protectTags is enabled", async () => {
    const sessionID = `ses_rc_tags_${Date.now()}`
    const raw = buildRaw(sessionID)
    raw[0]!.parts = [
        { type: "text", text: "Keep this: <protect>SECRET_CONFIG</protect> please" },
    ] as WithParts["parts"]
    const config = buildConfig({ protectTags: true })
    const { state, tool, run } = createHarness({ raw, config })

    await tool.execute({ ids: ["m0001"] }, run as any)

    const block = state.prune.messages.blocksById.get(1)
    assert.ok(block)
    assert.match(block.summary, /SECRET_CONFIG/)
    assert.match(block.summary, /protected prompt information/)
})

test("rc rejects partial coverage of an existing block", async () => {
    const { tool, run } = createHarness()
    await tool.execute({ ids: ["m0001-m0002"] }, run as any)

    await assert.rejects(
        tool.execute({ ids: ["m0002-m0003"] }, run as any),
        /partially covers compressed block b1/,
    )
})

test("rc rejects overlapping selectors in one call", async () => {
    const { tool, run } = createHarness()

    await assert.rejects(
        tool.execute({ ids: ["m0001-m0002", "m0002-m0003"] }, run as any),
        /overlap/,
    )
})

test("rc resets pending manual mode and emits notifications after applying", async () => {
    const config = buildConfig()
    config.pruneNotification = "detailed"
    config.pruneNotificationType = "toast"
    const { state, tool, run, toasts } = createHarness({ config })
    state.manualMode = "compress-pending"

    await tool.execute({ ids: ["m0001-m0002"] }, run as any)

    assert.notEqual(state.manualMode, "compress-pending")
    assert.equal(toasts.length, 1)
    assert.equal(toasts[0]?.body?.title, "DCP: Compress Notification")
})
