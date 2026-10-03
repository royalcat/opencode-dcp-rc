/**
 * Captures token usage of the hidden compression (summary) requests.
 *
 * OpenCode V2 `session.generate` returns only the reply text, so provider
 * usage is observed in two complementary ways: wrapping the resolved language
 * model through the `aisdk.language` hook (AI SDK packages) and reading the
 * raw response body through the session `http.response` hook (native
 * `@opencode/ai` packages, whose model never passes through the core AISDK
 * service). The session `generate` hook records a local input estimate as a
 * fallback for runtimes where neither capture path is available. All state is
 * kept in memory and keyed by the per-request call id embedded in the hidden
 * prompt marker.
 */

import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../logger"
import { countTokens } from "../token-utils"
import { extractSummaryCallId } from "../compress/summary"
import {
    estimatedCompressionUsage,
    normalizeProviderUsage,
    type CompressionUsage,
} from "../compress/usage"
import {
    AisdkPartScrubber,
    outputScrubEnabled,
    stripAisdkResultContent,
    type OutputScrubConfig,
} from "./scrub"

interface PendingUsage {
    provider?: CompressionUsage
    estimatedInput?: number
}

export interface CompressionUsageTracker {
    recordProvider(callId: string, usage: CompressionUsage): void
    recordEstimatedInput(callId: string, inputTokens: number): void
    /** Provider usage when captured, otherwise a tokenizer estimate, otherwise undefined. */
    resolve(callId: string, outputText: string): CompressionUsage | undefined
    discard(callId: string): void
}

export function createCompressionUsageTracker(): CompressionUsageTracker {
    const pending = new Map<string, PendingUsage>()

    const entry = (callId: string): PendingUsage => {
        let current = pending.get(callId)
        if (!current) {
            current = {}
            pending.set(callId, current)
        }
        return current
    }

    return {
        recordProvider(callId, usage) {
            entry(callId).provider = usage
        },
        recordEstimatedInput(callId, inputTokens) {
            if (Number.isFinite(inputTokens) && inputTokens > 0) {
                entry(callId).estimatedInput = Math.round(inputTokens)
            }
        },
        resolve(callId, outputText) {
            const current = pending.get(callId)
            if (!current) {
                return undefined
            }
            if (current.provider) {
                return current.provider
            }
            if (current.estimatedInput === undefined) {
                return undefined
            }
            return estimatedCompressionUsage(current.estimatedInput, countTokens(outputText))
        },
        discard(callId) {
            pending.delete(callId)
        },
    }
}

/** Depth-first search of the AI SDK call options for a summary marker. */
function findSummaryCallId(options: unknown): string | undefined {
    const texts: string[] = []
    collectTexts((options as { prompt?: unknown } | undefined)?.prompt, texts)
    for (const text of texts) {
        const callId = extractSummaryCallId(text)
        if (callId) {
            return callId
        }
    }
    return undefined
}

function collectTexts(value: unknown, out: string[], depth = 0): void {
    if (depth > 8 || out.length > 200) {
        return
    }
    if (typeof value === "string") {
        out.push(value)
        return
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            collectTexts(item, out, depth + 1)
        }
        return
    }
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>
        if (typeof record.text === "string") {
            out.push(record.text)
        }
        if (typeof record.content === "string") {
            out.push(record.content)
        } else if (Array.isArray(record.content)) {
            collectTexts(record.content, out, depth + 1)
        }
    }
}

function wrapLanguageModel(
    model: any,
    tracker: CompressionUsageTracker,
    logger: Logger,
    scrub?: OutputScrubConfig,
): any {
    return new Proxy(model, {
        get(target, property, receiver) {
            if (property === "doStream") {
                return (options: unknown) => trackedStream(target, options, tracker, logger, scrub)
            }
            if (property === "doGenerate") {
                return (options: unknown) =>
                    trackedGenerate(target, options, tracker, logger, scrub)
            }
            return Reflect.get(target, property, receiver)
        },
    })
}

async function trackedStream(
    target: any,
    options: unknown,
    tracker: CompressionUsageTracker,
    logger: Logger,
    scrub?: OutputScrubConfig,
): Promise<any> {
    const result = await target.doStream(options)
    const callId = findSummaryCallId(options)
    const scrubEnabled = !!scrub && outputScrubEnabled(scrub)
    logger.debug("Compression usage stream call", { callId: callId ?? null })
    const TransformStreamImpl = (globalThis as any).TransformStream
    if ((!callId && !scrubEnabled) || typeof result?.stream?.pipeThrough !== "function") {
        return result
    }
    if (typeof TransformStreamImpl !== "function") {
        return result
    }

    const partScrubber = scrubEnabled ? new AisdkPartScrubber(scrub!) : undefined
    let recorded = false
    const transform = new TransformStreamImpl({
        transform(part: any, controller: any) {
            try {
                if (callId && !recorded && part?.type === "finish" && part.usage) {
                    const usage = normalizeProviderUsage(part.usage)
                    if (usage) {
                        recorded = true
                        tracker.recordProvider(callId, usage)
                    }
                }
            } catch {
                // Never disturb the model stream because of usage accounting.
            }
            const parts = partScrubber ? partScrubber.process(part) : [part]
            for (const next of parts) {
                controller.enqueue(next)
            }
        },
    })
    return { ...result, stream: result.stream.pipeThrough(transform) }
}

async function trackedGenerate(
    target: any,
    options: unknown,
    tracker: CompressionUsageTracker,
    logger: Logger,
    scrub?: OutputScrubConfig,
): Promise<any> {
    const result = await target.doGenerate(options)
    const callId = findSummaryCallId(options)
    logger.debug("Compression usage generate call", { callId: callId ?? null })
    if (scrub && outputScrubEnabled(scrub)) {
        try {
            stripAisdkResultContent(result, scrub)
        } catch {
            // Never disturb the model result because of output scrubbing.
        }
    }
    if (!callId) {
        return result
    }
    const usage = normalizeProviderUsage(result?.usage)
    if (usage) {
        tracker.recordProvider(callId, usage)
    }
    return result
}

/**
 * Best-effort registration of the language-model wrapper. Runtimes without the
 * `aisdk` hook simply rely on the local estimate fallback.
 */
export async function installCompressionUsageHook(
    ctx: Plugin.Context,
    tracker: CompressionUsageTracker,
    logger: Logger,
    scrub?: OutputScrubConfig,
): Promise<void> {
    const aisdk = (ctx as any)?.aisdk
    if (!aisdk || typeof aisdk.hook !== "function") {
        logger.debug("aisdk hook unavailable; compression usage will be estimated")
        return
    }

    try {
        await aisdk.hook("language", (event: any) => {
            try {
                const isModel = (candidate: unknown) =>
                    !!candidate && typeof (candidate as any).doStream === "function"
                logger.debug("Compression usage hook event", {
                    modelID: event?.model?.modelID ?? event?.model?.id ?? null,
                    hasLanguage: isModel(event?.language),
                    hasFactory: typeof event?.sdk?.languageModel === "function",
                })
                // Another hook may already have resolved a model; otherwise fall
                // back to the provider SDK factory the core would use itself.
                let model: unknown = isModel(event?.language) ? event.language : undefined
                if (!model && typeof event?.sdk?.languageModel === "function") {
                    model = event.sdk.languageModel(
                        event?.model?.modelID ?? event?.model?.id,
                    ) as unknown
                }
                if (!isModel(model)) {
                    return
                }
                event.language = wrapLanguageModel(model, tracker, logger, scrub)
            } catch (error: any) {
                logger.debug("Compression usage hook could not wrap language model", {
                    error: error?.message,
                })
            }
        })
        logger.debug("Compression usage hook installed")
    } catch (error: any) {
        logger.warn("Compression usage hook registration failed", {
            error: error?.message,
        })
    }
}

interface UsageAccumulator {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning: number
    /** Anthropic reports cache tokens in addition to `input_tokens`. */
    exclusiveInput: boolean
}

function emptyUsageAccumulator(): UsageAccumulator {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        exclusiveInput: false,
    }
}

type UsageField = "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning"

function usageField(key: string): UsageField | undefined {
    switch (key) {
        case "input_tokens":
        case "prompt_tokens":
        case "promptTokenCount":
            return "input"
        case "output_tokens":
        case "completion_tokens":
        case "candidatesTokenCount":
            return "output"
        case "cache_read_input_tokens":
        case "cache_creation_input_tokens":
        case "cached_tokens":
        case "cachedContentTokenCount":
            return key === "cache_creation_input_tokens" ? "cacheWrite" : "cacheRead"
        case "reasoning_tokens":
        case "thoughtsTokenCount":
            return "reasoning"
        default:
            return undefined
    }
}

/** Merge every usage-like object found in a provider payload. */
function scanUsage(value: unknown, acc: UsageAccumulator, depth: number): void {
    if (depth > 8 || !value || typeof value !== "object") {
        return
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            scanUsage(item, acc, depth + 1)
        }
        return
    }
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const field = usageField(key)
        if (field && typeof raw === "number" && Number.isFinite(raw)) {
            acc[field] = Math.max(acc[field], raw)
            if (key === "cache_read_input_tokens" || key === "cache_creation_input_tokens") {
                acc.exclusiveInput = true
            }
            continue
        }
        if (raw && typeof raw === "object") {
            scanUsage(raw, acc, depth + 1)
        }
    }
}

function usageFromAccumulator(acc: UsageAccumulator): CompressionUsage | undefined {
    const input = acc.exclusiveInput ? acc.input + acc.cacheRead + acc.cacheWrite : acc.input
    const usage: CompressionUsage = {
        inputTokens: Math.max(0, Math.round(input)),
        outputTokens: Math.max(0, Math.round(acc.output)),
        cacheReadTokens: Math.max(0, Math.round(acc.cacheRead)),
        cacheWriteTokens: Math.max(0, Math.round(acc.cacheWrite)),
        reasoningTokens: Math.max(0, Math.round(acc.reasoning)),
        source: "provider",
    }
    const total =
        usage.inputTokens +
        usage.outputTokens +
        usage.cacheReadTokens +
        usage.cacheWriteTokens +
        usage.reasoningTokens
    return total > 0 ? usage : undefined
}

/**
 * Parse provider usage from a raw model response body. Handles plain JSON
 * bodies and SSE streams from the common provider protocols (OpenAI
 * responses/chat, Anthropic, Google) by merging every usage-like object.
 */
export function parseProviderUsageFromBody(body: string): CompressionUsage | undefined {
    const acc = emptyUsageAccumulator()
    const trimmed = body.trim()
    let parsedJson = false
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            scanUsage(JSON.parse(trimmed), acc, 0)
            parsedJson = true
        } catch {
            // Not a single JSON document; treat the body as an SSE stream.
        }
    }
    if (!parsedJson) {
        for (const line of body.split(/\r?\n/)) {
            const match = /^\s*data:\s*(.*)$/.exec(line)
            if (!match) {
                continue
            }
            const payload = match[1].trim()
            if (!payload || payload === "[DONE]") {
                continue
            }
            try {
                scanUsage(JSON.parse(payload), acc, 0)
            } catch {
                // Ignore malformed events.
            }
        }
    }
    return usageFromAccumulator(acc)
}

/**
 * Best-effort capture of provider usage from the raw HTTP response of the
 * hidden summary request. Needed for native `@opencode/ai` provider packages,
 * which bypass the core AISDK service entirely. The hook reads clones of the
 * request/response, so the real traffic is never disturbed, and any failure
 * falls back to the local estimate recorded by the `generate` hook.
 */
export async function installHttpUsageHook(
    ctx: Plugin.Context,
    tracker: CompressionUsageTracker,
    logger: Logger,
): Promise<void> {
    const session = (ctx as any)?.session
    if (!session || typeof session.hook !== "function") {
        return
    }

    try {
        await session.hook("http.response", async (event: any) => {
            if (event?.kind !== "generate") {
                return
            }
            try {
                const request = event.request
                const response = event.response
                if (!request || typeof request.clone !== "function") {
                    return
                }
                const callId = extractSummaryCallId(await request.clone().text())
                if (!callId) {
                    return
                }
                if (!response || typeof response.clone !== "function") {
                    return
                }
                const usage = parseProviderUsageFromBody(await response.clone().text())
                if (usage) {
                    tracker.recordProvider(callId, usage)
                    logger.debug("Compression usage captured from http response", {
                        callId,
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                    })
                }
            } catch (error: any) {
                logger.debug("Compression usage http capture failed", {
                    error: error?.message,
                })
            }
        })
        logger.debug("Compression usage http hook installed")
    } catch (error: any) {
        logger.warn("Compression usage http hook registration failed", {
            error: error?.message,
        })
    }
}
