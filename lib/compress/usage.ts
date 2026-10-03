/**
 * Usage accounting for the hidden compression (summary) request.
 *
 * Provider-reported usage is preferred: OpenCode V2 generates the summary
 * through `session.generate`, which does not surface token usage to the
 * caller, so the numbers are captured by wrapping the resolved language
 * model (`ctx.aisdk.hook("language")`) and reading the `finish` usage.
 * When that path is unavailable, local tokenizer estimates are recorded
 * instead so the plugin can still report an approximate cost.
 */

export type CompressionUsageSource = "provider" | "estimated"

/** Usage of a single hidden compression request. */
export interface CompressionUsage {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    source: CompressionUsageSource
}

/** Aggregated usage of all hidden compression requests in a session. */
export interface CompressionUsageTotals {
    calls: number
    providerCalls: number
    estimatedCalls: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
}

export function emptyCompressionUsage(): CompressionUsageTotals {
    return {
        calls: 0,
        providerCalls: 0,
        estimatedCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
    }
}

function toCount(value: unknown, fallback = 0): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return fallback
    }
    return Math.round(value)
}

/**
 * Normalize AI SDK v3 usage (`{ inputTokens: { total, noCache, cacheRead,
 * cacheWrite }, outputTokens: { total, text, reasoning } }`) into the plugin
 * shape. Returns undefined when there is nothing usable to record.
 */
export function normalizeProviderUsage(raw: unknown): CompressionUsage | undefined {
    if (!raw || typeof raw !== "object") {
        return undefined
    }

    const value = raw as { inputTokens?: unknown; outputTokens?: unknown }
    const input =
        value.inputTokens && typeof value.inputTokens === "object"
            ? (value.inputTokens as Record<string, unknown>)
            : {}
    const output =
        value.outputTokens && typeof value.outputTokens === "object"
            ? (value.outputTokens as Record<string, unknown>)
            : {}

    const cacheRead = toCount(input.cacheRead)
    const cacheWrite = toCount(input.cacheWrite)
    const uncached = toCount(input.noCache)
    const inputFromParts = uncached + cacheRead + cacheWrite
    const inputTotal = Math.max(toCount(input.total, inputFromParts), inputFromParts)

    const reasoning = toCount(output.reasoning)
    const outputTotal = Math.max(toCount(output.total, toCount(output.text) + reasoning), reasoning)

    if (
        inputTotal === 0 &&
        outputTotal === 0 &&
        cacheRead === 0 &&
        cacheWrite === 0 &&
        reasoning === 0
    ) {
        return undefined
    }

    return {
        inputTokens: inputTotal,
        outputTokens: outputTotal,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: reasoning,
        source: "provider",
    }
}

/** Local fallback when the provider did not report usage. */
export function estimatedCompressionUsage(
    inputTokens: number,
    outputTokens: number,
): CompressionUsage {
    return {
        inputTokens: toCount(inputTokens),
        outputTokens: toCount(outputTokens),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        source: "estimated",
    }
}

export function addCompressionUsage(
    totals: CompressionUsageTotals,
    usage: CompressionUsage,
): CompressionUsageTotals {
    return {
        calls: totals.calls + 1,
        providerCalls: totals.providerCalls + (usage.source === "provider" ? 1 : 0),
        estimatedCalls: totals.estimatedCalls + (usage.source === "estimated" ? 1 : 0),
        inputTokens: totals.inputTokens + usage.inputTokens,
        outputTokens: totals.outputTokens + usage.outputTokens,
        cacheReadTokens: totals.cacheReadTokens + usage.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens + usage.cacheWriteTokens,
        reasoningTokens: totals.reasoningTokens + usage.reasoningTokens,
    }
}

export function addCompressionUsageTotals(
    totals: CompressionUsageTotals,
    other: CompressionUsageTotals,
): CompressionUsageTotals {
    return {
        calls: totals.calls + other.calls,
        providerCalls: totals.providerCalls + other.providerCalls,
        estimatedCalls: totals.estimatedCalls + other.estimatedCalls,
        inputTokens: totals.inputTokens + other.inputTokens,
        outputTokens: totals.outputTokens + other.outputTokens,
        cacheReadTokens: totals.cacheReadTokens + other.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens + other.cacheWriteTokens,
        reasoningTokens: totals.reasoningTokens + other.reasoningTokens,
    }
}

/** Backward-compatible load of persisted totals. */
export function normalizeCompressionUsageTotals(value: unknown): CompressionUsageTotals {
    if (!value || typeof value !== "object") {
        return emptyCompressionUsage()
    }
    const raw = value as Record<string, unknown>
    return {
        calls: toCount(raw.calls),
        providerCalls: toCount(raw.providerCalls),
        estimatedCalls: toCount(raw.estimatedCalls),
        inputTokens: toCount(raw.inputTokens),
        outputTokens: toCount(raw.outputTokens),
        cacheReadTokens: toCount(raw.cacheReadTokens),
        cacheWriteTokens: toCount(raw.cacheWriteTokens),
        reasoningTokens: toCount(raw.reasoningTokens),
    }
}
