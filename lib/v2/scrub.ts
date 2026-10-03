/**
 * Removes DCP-injected metadata from model output before it reaches the stored
 * conversation or the user interface.
 *
 * The injected reminders, message-id tags and compact id lines are addressed to
 * the model, but models occasionally copy them into their visible reply or
 * reasoning. The request-side `stripHallucinations` pass keeps those copies out
 * of later requests; this module keeps them out of the stored history in the
 * first place by scrubbing the provider response stream. Two surfaces are
 * covered: raw HTTP responses (`http.response` hook, native provider packages)
 * and standardized AI SDK stream parts (`aisdk.language` hook).
 *
 * Every failure path falls back to the untouched response: scrubbing must never
 * break or delay model traffic.
 */

import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../logger"

export interface OutputScrubConfig {
    /** Strip `<dcp...>` reminder/tag blocks from model output. */
    modelOutput: boolean
    /** Strip line-standalone compact id tags (`@N@`, `@bN@`, `@blocked@`). */
    messageIds: boolean
}

export function outputScrubEnabled(config: OutputScrubConfig): boolean {
    return config.modelOutput || config.messageIds
}

// Local copies of the request-side patterns in lib/messages/utils.ts. They are
// intentionally duplicated: the request-side pass must stay untouched, and
// keeping the output-side patterns here makes the scrub module self-contained.
const DCP_PAIRED_TAG_REGEX = /<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi
const DCP_UNPAIRED_TAG_REGEX = /<\/?dcp[^>]*>/gi
const ID_LINE_REGEX =
    /^[ \t]*@(?:[1-9]\d*|b[1-9]\d*|blocked)@(?:[ \t]+\[(?:low|medium|high)\])?[ \t]*$/

function isIdLine(line: string): boolean {
    const value = line.endsWith("\r") ? line.slice(0, -1) : line
    return ID_LINE_REGEX.test(value)
}

/** True while `text` could still grow into a complete compact id line. */
function isIdLinePrefix(text: string): boolean {
    let index = 0
    while (index < text.length && (text[index] === " " || text[index] === "\t")) {
        index += 1
    }
    if (index === text.length) {
        return true
    }
    if (text[index] !== "@") {
        return false
    }
    index += 1
    if (index === text.length) {
        return true
    }
    if (text.startsWith("blocked", index)) {
        index += 7
    } else if (text[index] === "b") {
        if (index + 1 === text.length) {
            return true
        }
        if (!/\d/.test(text[index + 1]!)) {
            return false
        }
        index += 2
        while (index < text.length && /\d/.test(text[index]!)) {
            index += 1
        }
    } else if (/[1-9]/.test(text[index]!)) {
        index += 1
        while (index < text.length && /\d/.test(text[index]!)) {
            index += 1
        }
    } else {
        return false
    }
    if (index === text.length) {
        return true
    }
    if (text[index] !== "@") {
        return false
    }
    return isIdPriorityPrefix(text.slice(index + 1))
}

/** After the closing `@`: optional whitespace and an optional priority label. */
function isIdPriorityPrefix(text: string): boolean {
    if (text.length === 0 || /^[ \t]+$/.test(text)) {
        return true
    }
    return /^[ \t]*\[(?:l(?:o(?:w)?)?|m(?:e(?:d(?:i(?:u(?:m)?)?)?)?)?|h(?:i(?:g(?:h)?)?)?)?\]?[ \t]*$/.test(
        text,
    )
}

export function stripDcpArtifacts(text: string, config: OutputScrubConfig): string {
    let out = text
    if (config.modelOutput) {
        out = out.replace(DCP_PAIRED_TAG_REGEX, "").replace(DCP_UNPAIRED_TAG_REGEX, "")
    }
    if (config.messageIds && out.includes("\n")) {
        out = out
            .split("\n")
            .filter((line) => !isIdLine(line))
            .join("\n")
    } else if (config.messageIds && isIdLine(out)) {
        out = ""
    }
    return out
}

const TAG_OPEN = "<dcp"
const TAG_CLOSE = "</dcp"
const MAX_TAG_LENGTH = 512
const MAX_BLOCK_LENGTH = 8192

/** Longest suffix of `text` that could still be the start of a tag marker. */
function heldTagSuffix(text: string): string {
    const max = Math.min(4, text.length)
    for (let length = max; length >= 1; length -= 1) {
        const suffix = text.slice(text.length - length).toLowerCase()
        if (TAG_OPEN.startsWith(suffix) || TAG_CLOSE.startsWith(suffix)) {
            return text.slice(text.length - length)
        }
    }
    return ""
}

type TagMode = "text" | "open" | "close" | "block"

/**
 * Stateful `<dcp...>` remover. Tags may be split across arbitrary chunk
 * boundaries, so the stripper holds back only what could still complete into a
 * tag. Unpaired opening tags release their body on flush (matching the
 * request-side behavior of leaving non-tag content intact).
 */
class DcpTagStripper {
    private mode: TagMode = "text"
    private carry = ""

    push(chunk: string): string {
        this.carry += chunk
        let out = ""
        for (;;) {
            if (this.mode === "text") {
                const lower = this.carry.toLowerCase()
                const open = lower.indexOf(TAG_OPEN)
                const close = lower.indexOf(TAG_CLOSE)
                let index = -1
                let next: TagMode = "open"
                if (open === -1 && close === -1) {
                    index = -1
                } else if (open === -1) {
                    index = close
                    next = "close"
                } else if (close === -1) {
                    index = open
                } else if (open <= close) {
                    index = open
                } else {
                    index = close
                    next = "close"
                }
                if (index === -1) {
                    const held = heldTagSuffix(this.carry)
                    out += held ? this.carry.slice(0, -held.length) : this.carry
                    this.carry = held
                    break
                }
                out += this.carry.slice(0, index)
                this.carry = this.carry.slice(index)
                this.mode = next
                continue
            }
            if (this.mode === "open" || this.mode === "close") {
                const end = this.carry.indexOf(">")
                if (end === -1) {
                    if (this.carry.length > MAX_TAG_LENGTH) {
                        // Not a real tag after all; fail open.
                        out += this.carry
                        this.carry = ""
                        this.mode = "text"
                    }
                    break
                }
                const wasOpen = this.mode === "open"
                this.carry = this.carry.slice(end + 1)
                this.mode = wasOpen ? "block" : "text"
                continue
            }
            // Inside a paired block: drop everything through the closing tag.
            const close = this.carry.toLowerCase().indexOf(TAG_CLOSE)
            if (close !== -1) {
                const end = this.carry.indexOf(">", close)
                if (end !== -1) {
                    this.carry = this.carry.slice(end + 1)
                    this.mode = "text"
                    continue
                }
            }
            if (this.carry.length > MAX_BLOCK_LENGTH) {
                // Never seen a closing tag; fail open with the buffered body.
                out += this.carry
                this.carry = ""
                this.mode = "text"
            }
            break
        }
        return out
    }

    flush(): string {
        // A body without a closing tag is released (unpaired-tag semantics); a
        // partial tag or closing marker has no useful content and is dropped.
        const out = this.mode === "block" ? this.carry : ""
        this.carry = ""
        this.mode = "text"
        return out
    }

    reset(): void {
        this.carry = ""
        this.mode = "text"
    }
}

/**
 * Stateful compact-id line remover. Only lines that consist of nothing but a
 * compact id tag are removed; inline mentions elsewhere in the text are kept.
 */
class IdLineStripper {
    private carry = ""

    push(chunk: string): string {
        this.carry += chunk
        let out = ""
        for (;;) {
            const newline = this.carry.indexOf("\n")
            if (newline === -1) {
                if (isIdLinePrefix(this.carry)) {
                    break
                }
                out += this.carry
                this.carry = ""
                break
            }
            const line = this.carry.slice(0, newline)
            this.carry = this.carry.slice(newline + 1)
            if (!isIdLine(line)) {
                out += line + "\n"
            }
        }
        return out
    }

    flush(): string {
        const held = this.carry
        this.carry = ""
        return isIdLine(held) ? "" : held
    }

    reset(): void {
        this.carry = ""
    }
}

/** Streaming text scrubber: tag blocks first, then compact-id lines. */
export class DcpStreamScrubber {
    private readonly tags = new DcpTagStripper()
    private readonly ids = new IdLineStripper()

    constructor(private readonly config: OutputScrubConfig) {}

    push(chunk: string): string {
        let out = chunk
        if (this.config.modelOutput) {
            out = this.tags.push(out)
        }
        if (this.config.messageIds) {
            out = this.ids.push(out)
        }
        return out
    }

    flush(): string {
        let out = this.config.modelOutput ? this.tags.flush() : ""
        if (out && this.config.messageIds) {
            out = this.ids.push(out)
        }
        if (this.config.messageIds) {
            out += this.ids.flush()
        }
        return out
    }

    reset(): void {
        this.tags.reset()
        this.ids.reset()
    }
}

function assignText(target: Record<string, any>, key: string, value: string): boolean {
    if (target[key] === value) {
        return false
    }
    target[key] = value
    return true
}

const TEXT_PART_TYPES = new Set(["text", "output_text", "reasoning_text", "summary_text"])

/**
 * Scrubs provider payloads in place. Stateful for streamed deltas, complete
 * (stateless) for done/full payloads. Unknown shapes are left untouched.
 */
export class ProviderPayloadScrubber {
    private readonly streams = new Map<string, DcpStreamScrubber>()

    constructor(private readonly config: OutputScrubConfig) {}

    /** Scrub one streamed provider event. Returns true when it was modified. */
    scrub(payload: unknown): boolean {
        try {
            if (!payload || typeof payload !== "object") {
                return false
            }
            const record = payload as Record<string, any>
            const type = typeof record.type === "string" ? record.type : ""
            if (Array.isArray(record.choices)) {
                return this.scrubChat(record, false)
            }
            if (Array.isArray(record.candidates)) {
                return this.scrubGoogle(record, false)
            }
            if (type.startsWith("response.")) {
                return this.scrubResponses(record)
            }
            if (
                type.startsWith("content_block") ||
                type === "message" ||
                type === "message_delta"
            ) {
                return this.scrubAnthropic(record)
            }
            return false
        } catch {
            return false
        }
    }

    /** Scrub a complete (non-streamed) JSON payload. */
    scrubComplete(payload: unknown): boolean {
        try {
            if (Array.isArray(payload)) {
                let changed = false
                for (const item of payload) {
                    changed = this.scrubComplete(item) || changed
                }
                return changed
            }
            if (!payload || typeof payload !== "object") {
                return false
            }
            const record = payload as Record<string, any>
            if (Array.isArray(record.choices)) {
                return this.scrubChat(record, true)
            }
            if (Array.isArray(record.candidates)) {
                return this.scrubGoogle(record, true)
            }
            if (record.type === "message" && Array.isArray(record.content)) {
                return this.scrubAnthropic(record)
            }
            if (Array.isArray(record.output)) {
                return this.scrubItems(record.output)
            }
            if (typeof record.output_text === "string") {
                return assignText(record, "output_text", this.complete(record.output_text))
            }
            return false
        } catch {
            return false
        }
    }

    private complete(text: string): string {
        return stripDcpArtifacts(text, this.config)
    }

    private stream(key: string): DcpStreamScrubber {
        let scrubber = this.streams.get(key)
        if (!scrubber) {
            scrubber = new DcpStreamScrubber(this.config)
            this.streams.set(key, scrubber)
        }
        return scrubber
    }

    private textFor(value: string, key: string | undefined, complete: boolean): string {
        if (complete || !key) {
            return this.complete(value)
        }
        return this.stream(key).push(value)
    }

    private scrubField(target: any, key: string, streamKey?: string, complete = false): boolean {
        if (!target || typeof target !== "object" || typeof target[key] !== "string") {
            return false
        }
        return assignText(target, key, this.textFor(target[key], streamKey, complete))
    }

    private scrubParts(parts: unknown, key?: string, complete = false): boolean {
        if (!Array.isArray(parts)) {
            return false
        }
        let changed = false
        parts.forEach((part: any, index: number) => {
            if (!part || typeof part !== "object" || typeof part.text !== "string") {
                return
            }
            if (part.type && !TEXT_PART_TYPES.has(part.type)) {
                return
            }
            changed =
                assignText(
                    part,
                    "text",
                    this.textFor(part.text, key ? `${key}:${index}` : undefined, complete),
                ) || changed
        })
        return changed
    }

    private scrubChat(record: any, complete: boolean): boolean {
        let changed = false
        const choices = Array.isArray(record.choices) ? record.choices : []
        choices.forEach((choice: any, index: number) => {
            const delta = choice?.delta
            if (delta && typeof delta === "object") {
                changed = this.scrubField(delta, "content", `chat:content:${index}`) || changed
                changed =
                    this.scrubField(delta, "reasoning_content", `chat:reasoning:${index}`) ||
                    changed
                changed = this.scrubField(delta, "reasoning", `chat:reasoning:${index}`) || changed
                changed = this.scrubParts(delta.content, `chat:parts:${index}`) || changed
                if (choice?.finish_reason) {
                    this.streams.delete(`chat:content:${index}`)
                    this.streams.delete(`chat:reasoning:${index}`)
                    this.streams.delete(`chat:parts:${index}`)
                }
            }
            const message = choice?.message
            if (message && typeof message === "object") {
                changed = this.scrubField(message, "content", undefined, true) || changed
                changed = this.scrubField(message, "reasoning_content", undefined, true) || changed
                changed = this.scrubField(message, "reasoning", undefined, true) || changed
                changed = this.scrubParts(message.content, undefined, true) || changed
            }
        })
        return changed
    }

    private scrubResponses(record: any): boolean {
        const type = record.type as string
        const itemId = record.item_id ?? ""
        const outputIndex = record.output_index ?? ""
        const contentIndex = record.content_index ?? ""
        const key = (family: string) => `resp:${family}:${itemId}:${outputIndex}:${contentIndex}`
        switch (type) {
            case "response.output_text.delta":
                return this.scrubField(record, "delta", key("text"))
            case "response.reasoning_text.delta":
                return this.scrubField(record, "delta", key("reasoning"))
            case "response.reasoning_summary_text.delta":
                return this.scrubField(record, "delta", key("summary"))
            case "response.output_text.done":
            case "response.reasoning_text.done":
            case "response.reasoning_summary_text.done":
                return this.scrubField(record, "text", undefined, true)
            case "response.content_part.added":
            case "response.content_part.done":
            case "response.reasoning_summary_part.added":
            case "response.reasoning_summary_part.done":
                return this.scrubParts(record.part ? [record.part] : undefined, undefined, true)
            case "response.output_item.added":
            case "response.output_item.done":
                return this.scrubItems(record.item ? [record.item] : undefined)
            case "response.completed": {
                const changed = this.scrubResponseObject(record.response)
                this.streams.clear()
                return changed
            }
            default:
                return false
        }
    }

    private scrubResponseObject(response: any): boolean {
        if (!response || typeof response !== "object") {
            return false
        }
        let changed = this.scrubItems(response.output)
        if (typeof response.output_text === "string") {
            changed =
                assignText(response, "output_text", this.complete(response.output_text)) || changed
        }
        return changed
    }

    private scrubItems(items: unknown): boolean {
        if (!Array.isArray(items)) {
            return false
        }
        let changed = false
        items.forEach((entry: any) => {
            if (!entry || typeof entry !== "object") {
                return
            }
            changed = this.scrubParts(entry.content, undefined, true) || changed
            changed = this.scrubParts(entry.summary, undefined, true) || changed
        })
        return changed
    }

    private scrubAnthropic(record: any): boolean {
        const type = record.type
        if (type === "content_block_start") {
            const block = record.content_block
            if (!block || typeof block !== "object") {
                return false
            }
            if (block.type === "text") {
                return this.scrubField(block, "text", `anthropic:text:${record.index}`)
            }
            if (block.type === "thinking") {
                return this.scrubField(block, "thinking", `anthropic:thinking:${record.index}`)
            }
            return false
        }
        if (type === "content_block_delta") {
            const delta = record.delta
            if (!delta || typeof delta !== "object") {
                return false
            }
            if (delta.type === "text_delta") {
                return this.scrubField(delta, "text", `anthropic:text:${record.index}`)
            }
            if (delta.type === "thinking_delta") {
                return this.scrubField(delta, "thinking", `anthropic:thinking:${record.index}`)
            }
            return false
        }
        if (type === "content_block_stop") {
            this.streams.delete(`anthropic:text:${record.index}`)
            this.streams.delete(`anthropic:thinking:${record.index}`)
            return false
        }
        if (type === "message" && Array.isArray(record.content)) {
            let changed = false
            record.content.forEach((block: any) => {
                if (block?.type === "text") {
                    changed = this.scrubField(block, "text", undefined, true) || changed
                } else if (block?.type === "thinking") {
                    changed = this.scrubField(block, "thinking", undefined, true) || changed
                }
            })
            return changed
        }
        return false
    }

    private scrubGoogle(record: any, complete: boolean): boolean {
        const candidates = Array.isArray(record.candidates) ? record.candidates : []
        let changed = false
        candidates.forEach((candidate: any, candidateIndex: number) => {
            const parts = candidate?.content?.parts
            if (Array.isArray(parts)) {
                parts.forEach((part: any, partIndex: number) => {
                    if (!part || typeof part !== "object" || typeof part.text !== "string") {
                        return
                    }
                    changed =
                        assignText(
                            part,
                            "text",
                            this.textFor(
                                part.text,
                                complete ? undefined : `google:${candidateIndex}:${partIndex}`,
                                complete,
                            ),
                        ) || changed
                })
            }
            if (candidate?.finishReason) {
                this.streams.clear()
            }
        })
        return changed
    }
}

function findBoundary(buffer: string): { start: number; end: number; separator: string } | null {
    const lf = buffer.indexOf("\n\n")
    const crlf = buffer.indexOf("\r\n\r\n")
    if (lf === -1 && crlf === -1) {
        return null
    }
    if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
        return { start: crlf, end: crlf + 4, separator: "\r\n\r\n" }
    }
    return { start: lf, end: lf + 2, separator: "\n\n" }
}

/** Scrub a complete JSON body (non-streamed responses). */
export function scrubJsonBody(
    body: string,
    config: OutputScrubConfig,
    scrubber?: ProviderPayloadScrubber,
): string {
    const trimmed = body.trim()
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        return body
    }
    try {
        const payload = JSON.parse(trimmed)
        const worker = scrubber ?? new ProviderPayloadScrubber(config)
        if (worker.scrubComplete(payload)) {
            return JSON.stringify(payload)
        }
    } catch {
        // Malformed or unsupported bodies pass through untouched.
    }
    return body
}

/** SSE transformer that scrubs known provider events and passes the rest through. */
export function createSseScrubTransform(config: OutputScrubConfig): any {
    const TransformStreamImpl = (globalThis as any).TransformStream
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const scrubber = new ProviderPayloadScrubber(config)
    let buffer = ""

    const processBlock = (block: string): string => {
        try {
            const lines = block.split("\n")
            const dataLines: Array<{ index: number; space: string; value: string }> = []
            lines.forEach((raw, index) => {
                const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
                const match = /^data:( ?)(.*)$/.exec(line)
                if (match) {
                    dataLines.push({ index, space: match[1] ?? "", value: match[2] ?? "" })
                }
            })
            if (dataLines.length === 0) {
                return block
            }
            const data = dataLines.map((entry) => entry.value).join("\n")
            const payloadText = data.trim()
            if (!payloadText || payloadText === "[DONE]") {
                return block
            }
            let payload: unknown
            try {
                payload = JSON.parse(data)
            } catch {
                return block
            }
            if (!scrubber.scrub(payload)) {
                return block
            }
            const first = dataLines[0]!
            const drop = new Set(dataLines.slice(1).map((entry) => entry.index))
            const rebuilt: string[] = []
            lines.forEach((raw, index) => {
                if (drop.has(index)) {
                    return
                }
                if (index === first.index) {
                    rebuilt.push(`data:${first.space}${JSON.stringify(payload)}`)
                    return
                }
                rebuilt.push(raw)
            })
            return rebuilt.join("\n")
        } catch {
            return block
        }
    }

    return new TransformStreamImpl({
        transform(chunk: Uint8Array, controller: any) {
            let enqueued = false
            try {
                buffer += decoder.decode(chunk, { stream: true })
                let boundary = findBoundary(buffer)
                while (boundary) {
                    const block = buffer.slice(0, boundary.start)
                    buffer = buffer.slice(boundary.end)
                    controller.enqueue(encoder.encode(processBlock(block) + boundary.separator))
                    enqueued = true
                    boundary = findBoundary(buffer)
                }
            } catch {
                if (!enqueued) {
                    try {
                        controller.enqueue(chunk)
                    } catch {
                        // The stream is already closed; nothing to do.
                    }
                }
            }
        },
        flush(controller: any) {
            try {
                buffer += decoder.decode()
                if (buffer) {
                    controller.enqueue(encoder.encode(processBlock(buffer)))
                }
                buffer = ""
            } catch {
                // Never fail the response because of scrubbing.
            }
        },
    })
}

/** Buffers a JSON body, scrubs it at stream end. Used for non-SSE responses. */
export function createJsonScrubTransform(config: OutputScrubConfig): any {
    const TransformStreamImpl = (globalThis as any).TransformStream
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const scrubber = new ProviderPayloadScrubber(config)
    let buffer = ""

    return new TransformStreamImpl({
        transform(chunk: Uint8Array, _controller: any) {
            try {
                buffer += decoder.decode(chunk, { stream: true })
            } catch {
                // Ignore malformed byte sequences; the flush pass passes through.
            }
        },
        flush(controller: any) {
            try {
                buffer += decoder.decode()
                controller.enqueue(encoder.encode(scrubJsonBody(buffer, config, scrubber)))
                buffer = ""
            } catch {
                try {
                    controller.enqueue(encoder.encode(buffer))
                    buffer = ""
                } catch {
                    // The stream is already closed; nothing to do.
                }
            }
        },
    })
}

/**
 * Wrap a provider response so its body is scrubbed while streaming. Returns the
 * original response when nothing can or should be done.
 */
export function wrapScrubResponse(response: any, config: OutputScrubConfig): any {
    try {
        if (!response || typeof response !== "object" || !response.body) {
            return response
        }
        const headers = new Headers(response.headers)
        const contentType = headers.get("content-type") ?? ""
        let body: any
        if (/text\/event-stream/i.test(contentType)) {
            body = response.body.pipeThrough(createSseScrubTransform(config))
        } else if (/json/i.test(contentType)) {
            body = response.body.pipeThrough(createJsonScrubTransform(config))
        } else {
            return response
        }
        headers.delete("content-length")
        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        })
    } catch {
        return response
    }
}

/**
 * Best-effort registration of the response scrub hook. Applies to every session
 * request kind (primary, compaction, title, generate) through the shared HTTP
 * transport used by native provider packages. AI SDK providers are covered by
 * the language-model wrapper instead.
 */
export async function installResponseScrubHook(
    ctx: Plugin.Context,
    config: OutputScrubConfig,
    logger: Logger,
): Promise<void> {
    if (!outputScrubEnabled(config)) {
        return
    }
    const session = (ctx as any)?.session
    if (!session || typeof session.hook !== "function") {
        return
    }
    try {
        await session.hook("http.response", async (event: any) => {
            try {
                const response = event?.response
                if (!response || typeof response !== "object") {
                    return
                }
                const wrapped = wrapScrubResponse(response, config)
                if (wrapped !== response) {
                    event.response = wrapped
                }
            } catch (error: any) {
                logger.debug("DCP output scrub failed", { error: error?.message })
            }
        })
        logger.debug("DCP output scrub hook installed")
    } catch (error: any) {
        logger.warn("DCP output scrub hook registration failed", { error: error?.message })
    }
}

function isTextDelta(part: any): { family: string; field: string } | undefined {
    if (part?.type === "text-delta") {
        return { family: "text-delta", field: deltaField(part) }
    }
    if (part?.type === "reasoning-delta" || part?.type === "reasoning") {
        return { family: "reasoning-delta", field: deltaField(part) }
    }
    return undefined
}

function deltaField(part: any): string {
    if (typeof part.text === "string") {
        return "text"
    }
    if (typeof part.delta === "string") {
        return "delta"
    }
    return "textDelta"
}

/**
 * Standardized AI SDK stream-part scrubber. Deltas pass through a stateful
 * scrubber, end/finish parts are scrubbed statelessly, and any text the
 * scrubber held back is re-emitted as an extra delta before the end part.
 */
export class AisdkPartScrubber {
    private readonly streams = new Map<string, DcpStreamScrubber>()

    constructor(private readonly config: OutputScrubConfig) {}

    process(part: any): any[] {
        try {
            if (!part || typeof part !== "object") {
                return [part]
            }
            const delta = isTextDelta(part)
            if (delta) {
                const key = `${delta.family}:${part.id ?? ""}`
                return [{ ...part, [delta.field]: this.stream(key).push(part[delta.field]) }]
            }
            if (part.type === "text-start" || part.type === "reasoning-start") {
                const family = part.type === "text-start" ? "text-delta" : "reasoning-delta"
                this.streams.delete(`${family}:${part.id ?? ""}`)
                return [part]
            }
            if (part.type === "text-end" || part.type === "reasoning-end") {
                const family = part.type === "text-end" ? "text-delta" : "reasoning-delta"
                const out: any[] = []
                const leftover = this.take(`${family}:${part.id ?? ""}`)
                if (leftover) {
                    out.push({ type: family, id: part.id, text: leftover })
                }
                const field = deltaField(part)
                if (typeof part[field] === "string") {
                    out.push({ ...part, [field]: stripDcpArtifacts(part[field], this.config) })
                } else {
                    out.push(part)
                }
                return out
            }
            if (part.type === "finish") {
                return [...this.flushStreams(), part]
            }
            return [part]
        } catch {
            return [part]
        }
    }

    private stream(key: string): DcpStreamScrubber {
        let scrubber = this.streams.get(key)
        if (!scrubber) {
            scrubber = new DcpStreamScrubber(this.config)
            this.streams.set(key, scrubber)
        }
        return scrubber
    }

    private take(key: string): string {
        const scrubber = this.streams.get(key)
        if (!scrubber) {
            return ""
        }
        this.streams.delete(key)
        return scrubber.flush()
    }

    private flushStreams(): any[] {
        const out: any[] = []
        for (const [key, scrubber] of this.streams) {
            const leftover = scrubber.flush()
            if (!leftover) {
                continue
            }
            const separator = key.indexOf(":")
            out.push({
                type: separator === -1 ? "text-delta" : key.slice(0, separator),
                id: separator === -1 ? "" : key.slice(separator + 1),
                text: leftover,
            })
        }
        this.streams.clear()
        return out
    }
}

/** Stateless scrub of a non-streamed AI SDK result (`doGenerate`). */
export function stripAisdkResultContent(result: any, config: OutputScrubConfig): void {
    if (!result || !Array.isArray(result.content)) {
        return
    }
    for (const part of result.content) {
        if (!part || typeof part !== "object") {
            continue
        }
        if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
            part.text = stripDcpArtifacts(part.text, config)
        }
    }
}
