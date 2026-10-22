import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Logger } from "../lib/logger"

test("session passive override round-trips through persisted state", async () => {
    const previous = process.env.XDG_DATA_HOME
    const directory = await mkdtemp(join(tmpdir(), "dcp-passive-"))
    process.env.XDG_DATA_HOME = directory

    try {
        const { createSessionState } = await import("../lib/state")
        const { loadSessionState, saveSessionState } = await import("../lib/state/persistence")
        const logger = new Logger(false)

        const state = createSessionState()
        const sessionID = "ses_passive_override"
        state.sessionId = sessionID

        state.passiveModeOverride = true
        await saveSessionState(state, logger)
        assert.equal((await loadSessionState(sessionID, logger))?.passiveMode, true)

        state.passiveModeOverride = false
        await saveSessionState(state, logger)
        assert.equal((await loadSessionState(sessionID, logger))?.passiveMode, false)

        state.passiveModeOverride = undefined
        await saveSessionState(state, logger)
        assert.equal((await loadSessionState(sessionID, logger))?.passiveMode, undefined)
    } finally {
        if (previous === undefined) {
            delete process.env.XDG_DATA_HOME
        } else {
            process.env.XDG_DATA_HOME = previous
        }
        await rm(directory, { recursive: true, force: true })
    }
})
