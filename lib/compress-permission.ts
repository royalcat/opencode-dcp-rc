import type { PluginConfig } from "./config"
import type { SessionState } from "./state"

/**
 * How manual mode affects compression in the current session.
 * - "off": automatic nudges and strategies run normally.
 * - "trigger-required": nudges and strategies are off, and the model may only
 *   compress right after a manual trigger (`/dcp-compress`).
 * - "free": nudges and strategies are off, but the model may still call the
 *   compress tool when the user asks it to in chat.
 */
export type ManualCompressionMode = "off" | "trigger-required" | "free"

export const manualCompressionMode = (
    state: SessionState,
    config: PluginConfig,
): ManualCompressionMode => {
    if (!state.manualMode) {
        return "off"
    }
    return config.manualMode.allowCompressTool ? "free" : "trigger-required"
}

/** True when a compress call must be rejected because it was not manually triggered. */
export const compressBlockedByManualMode = (state: SessionState, config: PluginConfig): boolean =>
    state.manualMode === "active" && !config.manualMode.allowCompressTool

export const compressPermission = (
    state: SessionState,
    config: PluginConfig,
): "ask" | "allow" | "deny" => {
    return state.compressPermission ?? config.compress.permission
}
