import type { SessionState, WithParts } from "../state"
import type { PluginConfig } from "../config"
import {
    formatBlockRef,
    parseBoundaryId,
    parseMessageRef,
    type ParsedBoundaryId,
} from "../message-ids"
import { isIgnoredUserMessage, isProtectedUserMessage } from "../messages/query"
import { filterMessages } from "../messages/shape"
import { countAllMessageTokens } from "../token-utils"
import type { BoundaryReference, SearchContext, SelectionResolution } from "./types"

export async function fetchSessionMessages(client: any, sessionId: string): Promise<WithParts[]> {
    const response = await client.session.messages({
        path: { id: sessionId },
    })

    return filterMessages(response?.data || response)
}

export function buildSearchContext(state: SessionState, rawMessages: WithParts[]): SearchContext {
    const rawMessagesById = new Map<string, WithParts>()
    const rawIndexById = new Map<string, number>()
    for (const msg of rawMessages) {
        rawMessagesById.set(msg.info.id, msg)
    }
    for (let index = 0; index < rawMessages.length; index++) {
        const message = rawMessages[index]
        if (!message) {
            continue
        }
        rawIndexById.set(message.info.id, index)
    }

    const summaryByBlockId = new Map()
    for (const [blockId, block] of state.prune.messages.blocksById) {
        if (!block.active) {
            continue
        }
        summaryByBlockId.set(blockId, block)
    }

    return {
        rawMessages,
        rawMessagesById,
        rawIndexById,
        summaryByBlockId,
    }
}

function describeUnavailableBoundary(
    parsed: ParsedBoundaryId,
    context: SearchContext,
    state: SessionState,
): string {
    if (parsed.kind === "compressed-block") {
        const block = state.prune.messages.blocksById.get(parsed.blockId)
        return block && block.active
            ? `${parsed.ref} could not be mapped to a current message`
            : `${parsed.ref} is not an active compressed block`
    }

    const rawId = state.messageIds.byRef.get(parsed.ref)
    if (!rawId) {
        return `${parsed.ref} was never assigned in this session`
    }

    const message = context.rawMessagesById.get(rawId)
    if (!message) {
        return `${parsed.ref} refers to a message that is no longer in the current context`
    }
    if (message.info.role === "user") {
        return `${parsed.ref} refers to a user message, and user messages are not selectable`
    }

    return `${parsed.ref} is not selectable in the current context`
}

function formatNearestBoundaryRefs(
    lookup: Map<string, BoundaryReference>,
    parsed: ParsedBoundaryId,
    state: SessionState,
): string {
    const parts: string[] = []

    if (parsed.kind === "message") {
        let before: { ref: string; index: number } | undefined
        let after: { ref: string; index: number } | undefined
        for (const [ref, boundary] of lookup) {
            if (boundary.kind !== "message") {
                continue
            }
            const index = parseMessageRef(ref, state.idFormat)
            if (index === null) {
                continue
            }
            if (index < parsed.index && (!before || index > before.index)) {
                before = { ref, index }
            }
            if (index > parsed.index && (!after || index < after.index)) {
                after = { ref, index }
            }
        }

        const nearest = [
            ...(before ? [`${before.ref} (before)`] : []),
            ...(after ? [`${after.ref} (after)`] : []),
        ]
        if (nearest.length > 0) {
            parts.push(`nearest selectable message refs: ${nearest.join(", ")}`)
        } else {
            parts.push("no selectable message refs are available")
        }
    }

    const blocks = Array.from(lookup.entries())
        .filter(([, boundary]) => boundary.kind === "compressed-block")
        .map(([ref]) => ref)
    if (blocks.length > 0) {
        const shown = blocks.slice(0, 8).join(", ")
        const extra = blocks.length > 8 ? ` (+${blocks.length - 8} more)` : ""
        parts.push(`active blocks: ${shown}${extra}`)
    }

    return parts.join("; ")
}

function unavailableBoundaryIssue(
    label: "startId" | "endId",
    parsed: ParsedBoundaryId,
    lookup: Map<string, BoundaryReference>,
    context: SearchContext,
    state: SessionState,
): string {
    const reason = describeUnavailableBoundary(parsed, context, state)
    const available = formatNearestBoundaryRefs(lookup, parsed, state)
    const suffix = available.length > 0 ? ` ${available}.` : ""
    return `${label} ${parsed.ref} is not available in the current conversation context: ${reason}.${suffix} Choose an injected ID visible in context.`
}

export function resolveBoundaryIds(
    context: SearchContext,
    state: SessionState,
    config: PluginConfig,
    startId: string,
    endId: string,
): { startReference: BoundaryReference; endReference: BoundaryReference } {
    const lookup = buildBoundaryLookup(context, state, config)
    const issues: string[] = []
    const parsedStartId = parseBoundaryId(startId, state.idFormat)
    const parsedEndId = parseBoundaryId(endId, state.idFormat)
    const messageExample = state.idFormat === "compact" ? "@4@" : "mNNNN"
    const blockExample = state.idFormat === "compact" ? "@b1@" : "bN"

    if (parsedStartId === null) {
        issues.push(
            `startId is invalid. Use an injected message ID (${messageExample}) or block ID (${blockExample}).`,
        )
    }

    if (parsedEndId === null) {
        issues.push(
            `endId is invalid. Use an injected message ID (${messageExample}) or block ID (${blockExample}).`,
        )
    }

    if (issues.length > 0) {
        throw new Error(
            issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"),
        )
    }

    if (!parsedStartId || !parsedEndId) {
        throw new Error("Invalid boundary ID(s)")
    }

    const startReference = lookup.get(parsedStartId.ref)
    const endReference = lookup.get(parsedEndId.ref)

    if (!startReference) {
        issues.push(unavailableBoundaryIssue("startId", parsedStartId, lookup, context, state))
    }

    if (!endReference) {
        issues.push(unavailableBoundaryIssue("endId", parsedEndId, lookup, context, state))
    }

    if (issues.length > 0) {
        throw new Error(
            issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"),
        )
    }

    if (!startReference || !endReference) {
        throw new Error("Failed to resolve boundary IDs")
    }

    if (startReference.rawIndex > endReference.rawIndex) {
        throw new Error(
            `startId ${parsedStartId.ref} appears after endId ${parsedEndId.ref} in the conversation. Start must come before end.`,
        )
    }

    return { startReference, endReference }
}

export function resolveSelection(
    context: SearchContext,
    config: PluginConfig,
    startReference: BoundaryReference,
    endReference: BoundaryReference,
): SelectionResolution {
    const startRawIndex = startReference.rawIndex
    const endRawIndex = endReference.rawIndex
    const messageIds: string[] = []
    const messageSeen = new Set<string>()
    const toolIds: string[] = []
    const toolSeen = new Set<string>()
    const requiredBlockIds: number[] = []
    const requiredBlockSeen = new Set<number>()
    const messageTokenById = new Map<string, number>()

    for (let index = startRawIndex; index <= endRawIndex; index++) {
        const rawMessage = context.rawMessages[index]
        if (!rawMessage) {
            continue
        }
        if (isIgnoredUserMessage(rawMessage) || isProtectedUserMessage(config, rawMessage)) {
            continue
        }

        const messageId = rawMessage.info.id
        if (!messageSeen.has(messageId)) {
            messageSeen.add(messageId)
            messageIds.push(messageId)
        }

        if (!messageTokenById.has(messageId)) {
            messageTokenById.set(messageId, countAllMessageTokens(rawMessage))
        }

        const parts = Array.isArray(rawMessage.parts) ? rawMessage.parts : []
        for (const part of parts) {
            if (part.type !== "tool" || !part.callID) {
                continue
            }
            if (toolSeen.has(part.callID)) {
                continue
            }
            toolSeen.add(part.callID)
            toolIds.push(part.callID)
        }
    }

    const selectedMessageIds = new Set(messageIds)
    const summariesInSelection: Array<{ blockId: number; rawIndex: number }> = []
    for (const summary of context.summaryByBlockId.values()) {
        if (!selectedMessageIds.has(summary.anchorMessageId)) {
            continue
        }

        const anchorIndex = context.rawIndexById.get(summary.anchorMessageId)
        if (anchorIndex === undefined) {
            continue
        }

        summariesInSelection.push({
            blockId: summary.blockId,
            rawIndex: anchorIndex,
        })
    }

    summariesInSelection.sort((a, b) => a.rawIndex - b.rawIndex || a.blockId - b.blockId)
    for (const summary of summariesInSelection) {
        if (requiredBlockSeen.has(summary.blockId)) {
            continue
        }
        requiredBlockSeen.add(summary.blockId)
        requiredBlockIds.push(summary.blockId)
    }

    if (messageIds.length === 0) {
        throw new Error(
            "Failed to map boundary matches back to raw messages. Choose boundaries that include original conversation messages.",
        )
    }

    return {
        startReference,
        endReference,
        messageIds,
        messageTokenById,
        toolIds,
        requiredBlockIds,
    }
}

export function resolveAnchorMessageId(startReference: BoundaryReference): string {
    if (startReference.kind === "compressed-block") {
        if (!startReference.anchorMessageId) {
            throw new Error("Failed to map boundary matches back to raw messages")
        }
        return startReference.anchorMessageId
    }

    if (!startReference.messageId) {
        throw new Error("Failed to map boundary matches back to raw messages")
    }
    return startReference.messageId
}

function buildBoundaryLookup(
    context: SearchContext,
    state: SessionState,
    config: PluginConfig,
): Map<string, BoundaryReference> {
    const lookup = new Map<string, BoundaryReference>()

    for (const [messageRef, messageId] of state.messageIds.byRef) {
        const rawMessage = context.rawMessagesById.get(messageId)
        if (!rawMessage) {
            continue
        }
        if (isIgnoredUserMessage(rawMessage) || isProtectedUserMessage(config, rawMessage)) {
            continue
        }

        const rawIndex = context.rawIndexById.get(messageId)
        if (rawIndex === undefined) {
            continue
        }
        lookup.set(messageRef, {
            kind: "message",
            rawIndex,
            messageId,
        })
    }

    const summaries = Array.from(context.summaryByBlockId.values()).sort(
        (a, b) => a.blockId - b.blockId,
    )
    for (const summary of summaries) {
        const anchorMessage = context.rawMessagesById.get(summary.anchorMessageId)
        if (!anchorMessage) {
            continue
        }
        if (isIgnoredUserMessage(anchorMessage)) {
            continue
        }

        const rawIndex = context.rawIndexById.get(summary.anchorMessageId)
        if (rawIndex === undefined) {
            continue
        }
        const blockRef = formatBlockRef(summary.blockId, state.idFormat)
        if (!lookup.has(blockRef)) {
            lookup.set(blockRef, {
                kind: "compressed-block",
                rawIndex,
                blockId: summary.blockId,
                anchorMessageId: summary.anchorMessageId,
            })
        }
    }

    return lookup
}
