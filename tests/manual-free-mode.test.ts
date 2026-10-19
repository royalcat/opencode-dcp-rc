import assert from "node:assert/strict"
import test from "node:test"
import {
    compressBlockedByManualMode,
    manualCompressionMode,
    type ManualCompressionMode,
} from "../lib/compress-permission"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { renderSystemPrompt } from "../lib/prompts"
import {
    MANUAL_FREE_SYSTEM_EXTENSION,
    MANUAL_MODE_SYSTEM_EXTENSION,
} from "../lib/prompts/extensions/system"
import type { RuntimePrompts } from "../lib/prompts/store"
import { createSessionState, type WithParts } from "../lib/state"
import { deduplicate } from "../lib/strategies/deduplication"
import { purgeErrors } from "../lib/strategies/purge-errors"

const logger = new Logger(false)

function buildConfig(overrides: Partial<PluginConfig["manualMode"]> = {}): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
            allowCompressTool: false,
            ...overrides,
        },
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
    }
}

function buildMessages(): WithParts[] {
    return [
        {
            info: {
                id: "msg_user",
                role: "user",
                sessionID: "ses_manual_free",
                time: { created: 1 },
                model: { providerID: "lab", modelID: "model" },
            },
            parts: [{ type: "text", text: "Start" }],
        },
        {
            info: {
                id: "msg_assistant",
                role: "assistant",
                sessionID: "ses_manual_free",
                time: { created: 2 },
                tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [{ type: "text", text: "Done" }],
        },
    ] as WithParts[]
}

test("manual compression mode maps state and config to the effective mode", () => {
    const state = createSessionState()
    const config = buildConfig()

    assert.equal(manualCompressionMode(state, config), "off")

    state.manualMode = "active"
    assert.equal(manualCompressionMode(state, config), "trigger-required")

    assert.equal(manualCompressionMode(state, buildConfig({ allowCompressTool: true })), "free")

    // Pending triggers are always allowed, regardless of the option.
    state.manualMode = "compress-pending"
    assert.equal(manualCompressionMode(state, config), "trigger-required")
    assert.equal(compressBlockedByManualMode(state, config), false)
})

test("compress is only blocked by manual mode when the free option is off", () => {
    const state = createSessionState()
    state.manualMode = "active"

    assert.equal(compressBlockedByManualMode(state, buildConfig()), true)
    assert.equal(
        compressBlockedByManualMode(state, buildConfig({ allowCompressTool: true })),
        false,
    )

    state.manualMode = "compress-pending"
    assert.equal(compressBlockedByManualMode(state, buildConfig()), false)

    state.manualMode = false
    assert.equal(compressBlockedByManualMode(state, buildConfig()), false)
})

test("manual mode suppresses nudges with and without the free option", () => {
    const prompts = {
        contextLimitNudge: "CONTEXT_NUDGE",
        turnNudge: "TURN_NUDGE",
        iterationNudge: "ITERATION_NUDGE",
    } as RuntimePrompts

    const config = buildConfig()
    const automatic = createSessionState()
    const automaticMessages = buildMessages()
    injectCompressNudges(automatic, config, logger, automaticMessages, prompts)
    assert.match(JSON.stringify(automaticMessages), /NUDGE/, "nudges must fire without manual mode")

    for (const allowCompressTool of [false, true]) {
        const state = createSessionState()
        state.manualMode = "active"
        const messages = buildMessages()
        injectCompressNudges(state, buildConfig({ allowCompressTool }), logger, messages, prompts)
        assert.doesNotMatch(JSON.stringify(messages), /NUDGE/)
    }
})

test("manual mode with automaticStrategies off skips deduplication and error purging", () => {
    for (const strategy of ["deduplicate", "purgeErrors"] as const) {
        const state = createSessionState()
        state.manualMode = "active"
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

        const config = buildConfig({ automaticStrategies: false })
        if (strategy === "deduplicate") {
            deduplicate(state, logger, config, buildMessages())
        } else {
            purgeErrors(state, logger, config, buildMessages())
        }
        assert.equal(state.prune.tools.size, 0, `${strategy} should be skipped`)
    }
})

test("the free manual notice replaces the trigger-required notice", () => {
    const prompts = {
        system: "SYSTEM",
        manualExtension: MANUAL_MODE_SYSTEM_EXTENSION,
        manualFreeExtension: MANUAL_FREE_SYSTEM_EXTENSION,
        subagentExtension: "SUBAGENT",
    } as RuntimePrompts

    const modes: ManualCompressionMode[] = ["off", "trigger-required", "free"]
    const rendered = modes.map((mode) => renderSystemPrompt(prompts, undefined, mode))

    assert.equal(rendered[0], "SYSTEM")
    assert.match(rendered[1], /Do NOT use compress unless/)
    assert.match(rendered[2], /Do NOT compress proactively/)
    assert.match(rendered[2], /only when the user explicitly asks/)
    assert.doesNotMatch(rendered[2], /Do NOT use compress unless/)
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

async function runPrepareSession(config: PluginConfig, sessionID: string) {
    const state = createSessionState()
    state.sessionId = sessionID
    state.manualMode = "active"
    const { prepareSession } = await import("../lib/compress/pipeline")
    return prepareSession(
        buildToolContext(state, config) as any,
        {
            sessionID,
            metadata: () => {},
            ask: async () => {},
        },
        "Compress",
    )
}

test("prepareSession allows a free manual compress and blocks a trigger-required one", async () => {
    const freeConfig = buildConfig({ enabled: true, allowCompressTool: true })
    const free = await runPrepareSession(freeConfig, `ses_free_${Date.now()}`)
    assert.ok(free.rawMessages.length > 0)

    const gatedConfig = buildConfig({ enabled: true, allowCompressTool: false })
    await assert.rejects(
        runPrepareSession(gatedConfig, `ses_gated_${Date.now()}`),
        /Manual mode: compress blocked/,
    )
})
