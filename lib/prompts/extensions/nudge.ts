import type { SessionState } from "../../state"
import { formatBlockRef } from "../../message-ids"

/** Shared with the nudge-echo scrubber so the recognized text stays in sync. */
export const GUIDANCE_HEADER = "Compressed block context:"
export const GUIDANCE_BLOCK_LIST_PREFIX = "- Active compressed blocks in this session:"
export const GUIDANCE_BOUNDARY_PREFIX = "- Compressed blocks can be used as selection boundaries:"

export function buildCompressedBlockGuidance(state: SessionState): string {
    const refs = Array.from(state.prune.messages.activeBlockIds)
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((a, b) => a - b)
        .map((id) => formatBlockRef(id, state.idFormat))
    const blockCount = refs.length
    const blockList = blockCount > 0 ? refs.join(", ") : "none"

    return [
        GUIDANCE_HEADER,
        `${GUIDANCE_BLOCK_LIST_PREFIX} ${blockCount} (${blockList})`,
        `${GUIDANCE_BOUNDARY_PREFIX} include a block ID (or a range spanning it) to merge its summary into a new summary and retire the old block.`,
    ].join("\n")
}

export function appendGuidanceToDcpTag(nudgeText: string, guidance: string): string {
    if (!guidance.trim()) {
        return nudgeText
    }

    const closeTag = "</dcp-system-reminder>"
    const closeTagIndex = nudgeText.lastIndexOf(closeTag)

    if (closeTagIndex === -1) {
        return nudgeText
    }

    const beforeClose = nudgeText.slice(0, closeTagIndex).trimEnd()
    const afterClose = nudgeText.slice(closeTagIndex)
    return `${beforeClose}\n\n${guidance}\n${afterClose}`
}
