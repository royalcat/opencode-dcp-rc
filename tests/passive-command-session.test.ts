import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const logger = new Logger(false)

function buildConfig(): PluginConfig {
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
    }
}

function buildMessages(sessionID: string) {
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
    ] as any[]
}

test("the /dcp passive command changes state without touching the session", async () => {
    const previous = process.env.XDG_DATA_HOME
    const directory = await mkdtemp(join(tmpdir(), "dcp-passive-command-"))
    process.env.XDG_DATA_HOME = directory

    try {
        const { createCommandExecuteHandler } = await import("../lib/hooks")
        const { createSessionState } = await import("../lib/state")

        const sessionID = "ses_passive_command"
        const messages = buildMessages(sessionID)
        const writes: unknown[] = []
        const client = {
            session: {
                messages: async () => ({ data: messages }),
                prompt: async (input: unknown) => {
                    writes.push(input)
                },
                get: async () => ({ data: { parentID: null } }),
            },
            tui: { showToast: async () => {} },
        }

        const state = createSessionState()
        state.sessionId = sessionID
        const output = { parts: [] as any[] }
        const handler = createCommandExecuteHandler(client, state, logger, buildConfig(), directory)
        const before = JSON.stringify(messages)

        const prompt = await handler({ command: "dcp", sessionID, arguments: "passive on" }, output)

        assert.equal(prompt, undefined)
        assert.equal(state.passiveModeOverride, true)
        assert.equal(writes.length, 0, "the command must not prompt the session")
        assert.equal(output.parts.length, 0)
        assert.equal(JSON.stringify(messages), before, "the command must not edit messages")
    } finally {
        if (previous === undefined) {
            delete process.env.XDG_DATA_HOME
        } else {
            process.env.XDG_DATA_HOME = previous
        }
        await rm(directory, { recursive: true, force: true })
    }
})
