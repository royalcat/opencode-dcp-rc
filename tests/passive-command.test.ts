import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { PASSIVE_USAGE, formatPassiveStatus, handlePassiveCommand } from "../lib/commands/passive"
import { Logger } from "../lib/logger"
import { createSessionState } from "../lib/state"

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

test("passive command on, off, and reset only change session state", async () => {
    const state = createSessionState()
    const config = buildConfig()
    state.nudges.contextLimitAnchors.add("msg_assistant")
    state.nudges.turnNudgeAnchors.add("msg_assistant")
    state.nudges.iterationNudgeAnchors.add("msg_assistant")

    const on = await handlePassiveCommand({ state, config, logger }, ["on"])
    assert.match(on, /passive/)
    assert.equal(state.passiveModeOverride, true)
    assert.equal(state.nudges.contextLimitAnchors.size, 0)
    assert.equal(state.nudges.turnNudgeAnchors.size, 0)
    assert.equal(state.nudges.iterationNudgeAnchors.size, 0)

    const off = await handlePassiveCommand({ state, config, logger }, ["off"])
    assert.match(off, /enabled/)
    assert.equal(state.passiveModeOverride, false)

    const reset = await handlePassiveCommand({ state, config, logger }, ["reset"])
    assert.match(reset, /config default/)
    assert.equal(state.passiveModeOverride, undefined)
})

test("passive command status and invalid input are read-only", async () => {
    const state = createSessionState()
    const config = buildConfig({ passiveMode: true })

    const status = await handlePassiveCommand({ state, config, logger }, [])
    assert.match(status, /passive/)
    assert.equal(state.passiveModeOverride, undefined)

    const invalid = await handlePassiveCommand({ state, config, logger }, ["maybe"])
    assert.equal(invalid, PASSIVE_USAGE)
    assert.equal(state.passiveModeOverride, undefined)
    assert.equal(formatPassiveStatus(state, config), "passive (nudges off) · config default")
})

test("session override survives config changes in the status line", async () => {
    const state = createSessionState()
    const config = buildConfig()

    await handlePassiveCommand({ state, config, logger }, ["on"])
    assert.equal(formatPassiveStatus(state, config), "passive (nudges off) · session override")
    assert.equal(
        formatPassiveStatus(state, buildConfig({ passiveMode: true })),
        "passive (nudges off) · session override",
    )
})
