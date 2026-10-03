import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import type { PromptStore } from "../prompts/store"
import type { CompressionBlock, CompressionMode, SessionState, WithParts } from "../state"
import type { CompressionUsage } from "./usage"

/** Result of the hidden transient model call (OpenCode V2 `session.generate`). */
export interface GenerateSummaryResult {
    text: string
    /** Provider usage when captured, otherwise a local estimate. */
    usage?: CompressionUsage
}

export interface ToolContext {
    client: any
    state: SessionState
    logger: Logger
    config: PluginConfig
    prompts: PromptStore
    /** Hidden transient model call (OpenCode V2 `session.generate`). */
    generate: (input: {
        sessionID: string
        prompt: string
        /** Per-request id embedded in the prompt marker for usage attribution. */
        callId?: string
    }) => Promise<GenerateSummaryResult>
}

export interface BoundaryReference {
    kind: "message" | "compressed-block"
    rawIndex: number
    messageId?: string
    blockId?: number
    anchorMessageId?: string
}

export interface SearchContext {
    rawMessages: WithParts[]
    rawMessagesById: Map<string, WithParts>
    rawIndexById: Map<string, number>
    summaryByBlockId: Map<number, CompressionBlock>
}

export interface SelectionResolution {
    startReference: BoundaryReference
    endReference: BoundaryReference
    messageIds: string[]
    messageTokenById: Map<string, number>
    toolIds: string[]
    requiredBlockIds: number[]
}

export interface AppliedCompressionResult {
    compressedTokens: number
    messageIds: string[]
    newlyCompressedMessageIds: string[]
    newlyCompressedToolIds: string[]
}

export interface CompressionStateInput {
    topic: string
    batchTopic: string
    startId: string
    endId: string
    mode: CompressionMode
    runId: number
    compressMessageId: string
    compressCallId?: string
    summaryTokens: number
}
