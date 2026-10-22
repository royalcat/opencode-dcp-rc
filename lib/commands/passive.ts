/**
 * DCP passive command handler.
 *
 * Changes the session-scoped passive-mode override. This is a control-plane
 * operation only: it never writes to the conversation, so toggling modes
 * cannot invalidate the provider's prompt cache by editing stored history.
 */

import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import type { SessionState } from "../state"
import { saveSessionState } from "../state/persistence"
import {
    effectivePassiveMode,
    passiveModeSource,
    setPassiveMode,
    type PassiveModeAction,
} from "../passive-mode"

export interface PassiveCommandContext {
    state: SessionState
    config: PluginConfig
    logger: Logger
}

export const PASSIVE_USAGE = "Usage: /dcp passive [on|off|reset]"

export function formatPassiveStatus(state: SessionState, config: PluginConfig): string {
    const mode = effectivePassiveMode(state, config)
        ? "passive (nudges off)"
        : "enabled (nudges on)"
    const source = passiveModeSource(state) === "session" ? "session override" : "config default"
    return `${mode} · ${source}`
}

function parseAction(raw: string | undefined): PassiveModeAction | "status" | "invalid" {
    const action = raw?.toLowerCase()
    if (!action || action === "status") {
        return "status"
    }
    if (action === "on" || action === "off" || action === "reset") {
        return action
    }
    return "invalid"
}

export async function handlePassiveCommand(
    ctx: PassiveCommandContext,
    args: string[],
): Promise<string> {
    const action = parseAction(args[0])

    if (action === "invalid") {
        return PASSIVE_USAGE
    }

    if (action === "status") {
        return formatPassiveStatus(ctx.state, ctx.config)
    }

    setPassiveMode(ctx.state, ctx.config, action)
    await saveSessionState(ctx.state, ctx.logger)

    ctx.logger.info("Passive mode changed", {
        sessionID: ctx.state.sessionId,
        action,
        passiveMode: effectivePassiveMode(ctx.state, ctx.config),
        source: passiveModeSource(ctx.state),
    })

    return `Passive mode: ${formatPassiveStatus(ctx.state, ctx.config)}`
}
