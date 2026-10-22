import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { renderSystemPrompt } from "../lib/prompts"
import type { RuntimePrompts } from "../lib/prompts/store"
import { createSessionState, type WithParts } from "../lib/state"
import { effectivePassiveMode, passiveModeSource, setPassiveMode } from "../lib/passive-mode"
import { deduplicate } from "../lib/strategies/deduplication"
import { purgeErrors } from "../lib/strategies/purge-errors"

const logger = new Logger(false)

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
    return {
        enabled: true,
        passiveMode: false,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 0,
            minContextLimit: 0,
            nudgeFrequency: 1,
            iterationNudgeThreshold: 1,
            nudgeForce: "strong",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            scrubModelOutput: true,
            scrubMessageIds: true,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 1, protectedTools: [] },
        },
        ...overrides,
    }
}

function buildMessages(sessionID = "ses_modes"): WithParts[] {
    return [
        {
            info: {
                id: "msg_user",
                role: "user",
                sessionID,
                time: { created: 1 },
                model: { providerID: "lab", modelID: "model" },
            },
            parts: [{ type: "text", text: "Start" }],
        },
        {
            info: {
                id: "msg_assistant",
                role: "assistant",
                sessionID,
                time: { created: 2 },
                tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [{ type: "text", text: "Done" }],
        },
    ] as WithParts[]
}

const nudgePrompts = {
    contextLimitNudge: "CONTEXT_NUDGE",
    turnNudge: "TURN_NUDGE",
    iterationNudge: "ITERATION_NUDGE",
} as RuntimePrompts

test("free mode fires nudges; passive mode suppresses them", () => {
    const free = createSessionState()
    const freeMessages = buildMessages()
    injectCompressNudges(free, buildConfig(), logger, freeMessages, nudgePrompts)
    assert.match(JSON.stringify(freeMessages), /NUDGE/, "free mode must fire nudges")

    const passive = createSessionState()
    const passiveMessages = buildMessages()
    injectCompressNudges(
        passive,
        buildConfig({ passiveMode: true }),
        logger,
        passiveMessages,
        nudgePrompts,
    )
    assert.doesNotMatch(JSON.stringify(passiveMessages), /NUDGE/)
})

test("passive mode clears previously anchored nudges", () => {
    const state = createSessionState()
    state.nudges.contextLimitAnchors.add("msg_assistant")
    state.nudges.turnNudgeAnchors.add("msg_assistant")

    injectCompressNudges(
        state,
        buildConfig({ passiveMode: true }),
        logger,
        buildMessages(),
        nudgePrompts,
    )

    assert.equal(state.nudges.contextLimitAnchors.size, 0)
    assert.equal(state.nudges.turnNudgeAnchors.size, 0)
})

test("session passive override wins over a free config", () => {
    const state = createSessionState()
    state.passiveModeOverride = true
    const messages = buildMessages()

    injectCompressNudges(state, buildConfig(), logger, messages, nudgePrompts)

    assert.doesNotMatch(JSON.stringify(messages), /NUDGE/)
    assert.equal(effectivePassiveMode(state, buildConfig()), true)
    assert.equal(passiveModeSource(state), "session")
})

test("session passive override off wins over a passive config", () => {
    const state = createSessionState()
    state.passiveModeOverride = false
    const messages = buildMessages()

    injectCompressNudges(state, buildConfig({ passiveMode: true }), logger, messages, nudgePrompts)

    assert.match(JSON.stringify(messages), /NUDGE/)
    assert.equal(effectivePassiveMode(state, buildConfig({ passiveMode: true })), false)
    assert.equal(passiveModeSource(state), "session")
})

test("setPassiveMode clears anchors when enabling and reset restores config", () => {
    const state = createSessionState()
    state.nudges.contextLimitAnchors.add("msg_assistant")
    state.nudges.turnNudgeAnchors.add("msg_assistant")
    state.nudges.iterationNudgeAnchors.add("msg_assistant")
    const config = buildConfig()

    setPassiveMode(state, config, "on")
    assert.equal(effectivePassiveMode(state, config), true)
    assert.equal(state.nudges.contextLimitAnchors.size, 0)
    assert.equal(state.nudges.turnNudgeAnchors.size, 0)
    assert.equal(state.nudges.iterationNudgeAnchors.size, 0)

    setPassiveMode(state, config, "reset")
    assert.equal(state.passiveModeOverride, undefined)
    assert.equal(effectivePassiveMode(state, config), false)
    assert.equal(passiveModeSource(state), "config")
})

test("passive mode does not disable deduplication or error purging", () => {
    for (const strategy of ["deduplicate", "purgeErrors"] as const) {
        const state = createSessionState()
        state.currentTurn = 10
        state.toolIdList = ["tool_1", "tool_2"]
        state.toolParameters.set("tool_1", {
            tool: "read",
            parameters: { filePath: "/tmp/a" },
            status: "error",
            turn: 0,
            tokenCount: 100,
        })
        state.toolParameters.set("tool_2", {
            tool: "read",
            parameters: { filePath: "/tmp/a" },
            status: "completed",
            turn: 9,
            tokenCount: 100,
        })

        const config = buildConfig({ passiveMode: true })
        if (strategy === "deduplicate") {
            deduplicate(state, logger, config, buildMessages())
        } else {
            purgeErrors(state, logger, config, buildMessages())
        }
        assert.ok(state.prune.tools.size > 0, `${strategy} must still run in passive mode`)
    }
})

test("the system prompt has no manual-mode extensions", () => {
    const prompts = {
        system: "SYSTEM",
        subagentExtension: "SUBAGENT",
    } as RuntimePrompts

    assert.equal(renderSystemPrompt(prompts), "SYSTEM")
    assert.equal(renderSystemPrompt(prompts, undefined, true), "SYSTEM\n\nSUBAGENT")
})

function buildToolContext(state: ReturnType<typeof createSessionState>, config: PluginConfig) {
    return {
        client: {
            session: {
                messages: async () => ({ data: buildMessages() }),
                get: async () => ({ data: { parentID: null } }),
            },
            tui: { showToast: async () => {} },
        },
        state,
        logger,
        config,
        prompts: { reload() {}, getRuntimePrompts: () => ({}) },
    }
}

test("prepareSession allows compression without any trigger state", async () => {
    const { prepareSession } = await import("../lib/compress/pipeline")
    const sessionID = `ses_free_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID

    const prepared = await prepareSession(
        buildToolContext(state, buildConfig()) as any,
        { sessionID, metadata: () => {}, ask: async () => {} },
        "Compress",
    )

    assert.ok(prepared.rawMessages.length > 0)
})
