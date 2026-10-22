import type { PluginConfig } from "./config"
import type { SessionState } from "./state"

/**
 * Session-scoped passive-mode override.
 *
 * `config.passiveMode` is the default. A running session may override it with
 * `on` / `off`; `reset` drops the override. The override is persisted with the
 * session's DCP state and never touches the conversation itself: it only gates
 * nudge injection into outgoing request copies.
 */
export type PassiveModeAction = "on" | "off" | "reset"
export type PassiveModeSource = "config" | "session"

export const effectivePassiveMode = (state: SessionState, config: PluginConfig): boolean =>
    state.passiveModeOverride ?? config.passiveMode

export const passiveModeSource = (state: SessionState): PassiveModeSource =>
    state.passiveModeOverride === undefined ? "config" : "session"

/**
 * Apply an override and clear pending nudge anchors when the effective mode is
 * passive. Only DCP state changes; no session messages are read or written.
 */
export const setPassiveMode = (
    state: SessionState,
    config: PluginConfig,
    action: PassiveModeAction,
): void => {
    state.passiveModeOverride = action === "reset" ? undefined : action === "on"

    if (!effectivePassiveMode(state, config)) {
        return
    }

    state.nudges.contextLimitAnchors.clear()
    state.nudges.turnNudgeAnchors.clear()
    state.nudges.iterationNudgeAnchors.clear()
}
