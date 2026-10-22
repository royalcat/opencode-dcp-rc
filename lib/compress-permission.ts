import type { PluginConfig } from "./config"
import type { SessionState } from "./state"

/** Resolve the compression permission for the current session. */
export const compressPermission = (
    state: SessionState,
    config: PluginConfig,
): "ask" | "allow" | "deny" => {
    return state.compressPermission ?? config.compress.permission
}
