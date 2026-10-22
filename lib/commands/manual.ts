/**
 * DCP manual compression snippet.
 *
 * `/dcp-compress` only sends an instruction that asks the model to compress;
 * there is no trigger state, gate, or per-call limit. The compress tool is
 * always available while the plugin is enabled.
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { buildCompressedBlockGuidance } from "../prompts/extensions/nudge"

const COMPRESS_SNIPPET = [
    "Compress the significant completed conversation content into high-fidelity technical summaries.",
    "Find the most significant completed content that can be compressed, preserve all critical implementation details, and choose safe targets.",
    "Prefer one broad selection. Use more than one compress call only for independent selections, and never call compress in parallel.",
    "Return after compressing with a brief explanation of what content was compressed.",
].join("\n\n")

export interface ManualCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

export function buildCompressSnippet(state: SessionState, userFocus?: string): string {
    const sections = [COMPRESS_SNIPPET, buildCompressedBlockGuidance(state)]
    if (userFocus && userFocus.trim().length > 0) {
        sections.push(`Additional user focus:\n${userFocus.trim()}`)
    }

    return sections.join("\n\n")
}

export async function handleCompressCommand(
    ctx: ManualCommandContext,
    userFocus?: string,
): Promise<string> {
    return buildCompressSnippet(ctx.state, userFocus)
}
