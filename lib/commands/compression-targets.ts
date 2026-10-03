import type { CompressionBlock, PruneMessagesState } from "../state"

export interface CompressionTarget {
    displayId: number
    runId: number
    topic: string
    compressedTokens: number
    durationMs: number
    blocks: CompressionBlock[]
}

function byBlockId(a: CompressionBlock, b: CompressionBlock): number {
    return a.blockId - b.blockId
}

function buildTarget(block: CompressionBlock): CompressionTarget {
    return {
        displayId: block.blockId,
        runId: block.runId,
        topic: block.topic,
        compressedTokens: block.compressedTokens,
        durationMs: block.durationMs,
        blocks: [block],
    }
}

export function getActiveCompressionTargets(
    messagesState: PruneMessagesState,
): CompressionTarget[] {
    return Array.from(messagesState.activeBlockIds)
        .map((blockId) => messagesState.blocksById.get(blockId))
        .filter((block): block is CompressionBlock => !!block && block.active)
        .sort(byBlockId)
        .map(buildTarget)
}

export function getRecompressibleCompressionTargets(
    messagesState: PruneMessagesState,
    availableMessageIds: Set<string>,
): CompressionTarget[] {
    return Array.from(messagesState.blocksById.values())
        .filter((block) => availableMessageIds.has(block.compressMessageId))
        .filter((block) => block.deactivatedByUser && !block.active)
        .sort(byBlockId)
        .map(buildTarget)
}

export function resolveCompressionTarget(
    messagesState: PruneMessagesState,
    blockId: number,
): CompressionTarget | null {
    const block = messagesState.blocksById.get(blockId)
    return block ? buildTarget(block) : null
}
