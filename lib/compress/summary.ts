import type { WithParts } from "../state"
import { formatBlockRef, formatMessageRef, parseBoundaryId, type IdFormat } from "../message-ids"

/**
 * Marker embedded in the hidden summary prompt so the plugin can recognize its
 * own transient (`session.generate`) request and strip everything else from it.
 * Requests carry a per-call suffix (`[[DCP-RC-SUMMARY:<callId>]]`) so captured
 * provider usage can be attributed to a specific request.
 */
export const RC_SUMMARY_MARKER = "[[DCP-RC-SUMMARY]]"
/** Prefix shared by the static marker and its per-call variant. */
export const RC_SUMMARY_MARKER_PREFIX = "[[DCP-RC-SUMMARY"

function sanitizeCallId(callId: string): string {
    return callId.replace(/[^A-Za-z0-9_-]/g, "-")
}

/** Marker line for a hidden summary request, optionally tagged with a call id. */
export function buildSummaryMarker(callId?: string): string {
    if (!callId) {
        return RC_SUMMARY_MARKER
    }
    return `${RC_SUMMARY_MARKER_PREFIX}:${sanitizeCallId(callId)}]]`
}

/** True when the text contains a hidden summary marker, with or without a call id. */
export function hasSummaryMarker(text: string): boolean {
    return text.includes(RC_SUMMARY_MARKER_PREFIX)
}

/** Extract the call id from a hidden summary marker, when present. */
export function extractSummaryCallId(text: string): string | undefined {
    return text.match(/\[\[DCP-RC-SUMMARY:([A-Za-z0-9_-]+)\]\]/)?.[1]
}

export interface PriorSummary {
    /** Canonical block reference, e.g. `b2` or `@b2@`. */
    ref: string
    /** Summary body with the block header/footer stripped. */
    body: string
}

export interface SummarySegment {
    /** Canonical selector, e.g. `m0004`, `m0004-m0008`, or `b2-m0011`. */
    selector: string
    messages: WithParts[]
    /** Summaries of active blocks consumed by this selection. */
    priorSummaries?: PriorSummary[]
}

export interface SummarySection {
    selector: string
    summary: string
}

export interface ParsedSummarySections {
    sections: SummarySection[]
    missing: string[]
    duplicates: string[]
    empty: string[]
}

function stringify(value: unknown): string {
    if (typeof value === "string") {
        return value
    }
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

function readToolState(part: any): {
    status?: string
    input?: unknown
    output?: unknown
    error?: unknown
} {
    const state = part?.state
    if (!state || typeof state !== "object") {
        return {}
    }
    return {
        status: typeof state.status === "string" ? state.status : undefined,
        input: state.input,
        output: state.output,
        error: state.error,
    }
}

/**
 * Serialize one conversation message into plain text for the hidden summary
 * request. Binary/file payloads are intentionally omitted.
 */
export function serializeMessageForSummary(message: WithParts, selector: string): string {
    const role = message.info?.role ?? "unknown"
    const lines: string[] = []
    const parts = Array.isArray(message.parts) ? message.parts : []

    for (const part of parts as any[]) {
        if (!part || typeof part !== "object") {
            continue
        }
        switch (part.type) {
            case "text":
                if (typeof part.text === "string" && part.text.length > 0) {
                    lines.push(part.text)
                }
                break
            case "reasoning":
                if (typeof part.text === "string" && part.text.length > 0) {
                    lines.push(`[reasoning] ${part.text}`)
                }
                break
            case "tool": {
                const state = readToolState(part)
                const name = part.tool ?? "tool"
                lines.push(`[tool_call ${name}] ${stringify(state.input)}`)
                if (state.status === "completed") {
                    lines.push(`[tool_result ${name}] ${stringify(state.output)}`)
                } else if (state.status === "error") {
                    lines.push(`[tool_error ${name}] ${stringify(state.error)}`)
                } else if (state.status) {
                    lines.push(`[tool_${state.status} ${name}]`)
                }
                break
            }
            case "file":
                lines.push(`[file ${part.mime ?? ""} ${part.filename ?? part.url ?? ""}]`.trim())
                break
            case "patch":
                lines.push(`[patch] ${stringify(part.hash ?? part.files ?? part)}`)
                break
            case "agent":
                lines.push(`[agent ${part.name ?? ""}]`.trim())
                break
            default:
                break
        }
    }

    const body = lines.join("\n").trim()
    return `### ${selector} (${role})\n${body.length > 0 ? body : "(empty message)"}`
}

const SUMMARY_RULES = `RULES
- Reply with one section per selector, in the same order as listed. Nothing else: no introduction, no code fences, no tool calls, no trailing prose.
- Each section starts with a header line exactly \`SLEEV-SUMMARY <selector>\` using the selector as listed.
- The summary body continues until the next header or the end of the reply.
- When a segment lists previous compressed summaries, merge their information into your summary: those blocks are replaced by the section you produce.
- Preserve every high-signal detail: user intent (quote short user messages exactly), decisions, constraints, file paths, function and symbol names, commands run, key findings, errors, verification results, and any subagent task IDs with their scope and completion state.
- Drop noise: failed attempts that led nowhere, repeated tool output, exploration that produced no durable result.
- Be dense and precise. Prefer terse technical wording over narrative.`

/**
 * Build the hidden summarization prompt. The selected segments are embedded
 * verbatim so the transient request does not depend on any injected metadata.
 */
export function buildSummaryPrompt(
    selectors: SummarySegment[],
    idFormat: IdFormat = "xml",
    callId?: string,
): string {
    const selectorList = selectors.map((segment) => segment.selector)
    const example = selectorList[0] ?? (idFormat === "compact" ? "" : "m0004")
    const body = selectors
        .map((segment) => {
            const messageBody = segment.messages
                .map((message) => serializeMessageForSummary(message, segment.selector))
                .join("\n\n")
            const priorBody = (segment.priorSummaries ?? [])
                .map(
                    (prior) =>
                        `### ${prior.ref} (previous compressed summary)\n${prior.body.trim()}`,
                )
                .join("\n\n")
            return [messageBody, priorBody].filter((part) => part.length > 0).join("\n\n")
        })
        .join("\n\n")

    return `${buildSummaryMarker(callId)}

You generate compressed-context entries for a coding session. Summarize ONLY the conversation segments listed below. Do not summarize anything else and do not ask questions.

SUMMARY FORMAT
SLEEV-SUMMARY ${example}
<summary body>

${SUMMARY_RULES.replace("one section per selector", `${selectorList.length} section(s), one per selector`)}
- The selectors for this request are exactly: ${selectorList.map((selector) => `\`${selector}\``).join(", ")}
RC-SELECTORS: ${selectorList.join(", ")}

SEGMENTS
${body}
`
}

function selectorPattern(): string {
    const boundary = "(?:m[0-9]{4}|@[0-9]+@|b[1-9][0-9]*|@b[1-9][0-9]*@)"
    return `(?:${boundary})(?:-${boundary})?`
}

/**
 * Normalize a selector written in either ID format (`m0004` or ``) into the
 * session's canonical format. Returns null when the selector is malformed.
 */
export function canonicalizeSelector(selector: string, format: IdFormat = "xml"): string | null {
    const parts = selector.trim().toLowerCase().split("-")
    if (parts.length < 1 || parts.length > 2) {
        return null
    }
    const parse = (part: string) => parseBoundaryId(part, "xml") ?? parseBoundaryId(part, "compact")
    const toRef = (parsed: NonNullable<ReturnType<typeof parse>>): string =>
        parsed.kind === "message"
            ? formatMessageRef(parsed.index, format)
            : formatBlockRef(parsed.blockId, format)

    const start = parse(parts[0]!)
    const end = parts.length === 2 ? parse(parts[1]!) : start
    if (!start || !end) {
        return null
    }
    if (start.kind === "message" && end.kind === "message" && start.index > end.index) {
        return null
    }
    const startRef = toRef(start)
    const endRef = toRef(end)
    return startRef === endRef ? startRef : `${startRef}-${endRef}`
}

/**
 * Strip the `[Compressed conversation section]` header and trailing block tag
 * from a stored summary so it can be embedded in a new summary prompt.
 */
export function restoreSummary(summary: string): string {
    const headerMatch = summary.match(
        /^[ \t]*\[Compressed conversation(?: section)?(?: b[0-9]+)?\]/i,
    )
    if (!headerMatch) {
        return summary
    }

    const body = summary.slice(headerMatch[0].length).trimStart()
    const lines = body.split("\n")
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
        lines.pop()
    }
    const last = (lines[lines.length - 1] ?? "").trim()
    const isXmlTag = new RegExp("^<dcp-message-id>b[0-9]+</dcp-message-id>$").test(last)
    const isCompactTag = /^@b[1-9][0-9]*@$/.test(last)
    if (isXmlTag || isCompactTag) {
        lines.pop()
    }
    return lines.join("\n").trimEnd()
}

/**
 * Parse `SLEEV-SUMMARY <selector>` sections from a model reply. Returns the
 * accepted sections plus the selectors that are missing, duplicated, or have
 * an empty body so the caller can retry only what is needed. Selectors are
 * accepted in either ID format and normalized to the session format.
 */
export function parseSummarySections(
    text: string,
    expected: string[],
    idFormat: IdFormat = "xml",
): ParsedSummarySections {
    const header = new RegExp(`^SLEEV-SUMMARY (${selectorPattern()})[ \t]*$`, "gmi")
    const matches: Array<{ selector: string; start: number; end: number }> = []
    let match: RegExpExecArray | null

    while ((match = header.exec(text)) !== null) {
        const selector = canonicalizeSelector((match[1] ?? "").trim(), idFormat)
        if (!selector) {
            continue
        }
        matches.push({
            selector,
            start: match.index,
            end: match.index + match[0].length,
        })
    }

    const normalizedExpected = expected
        .map((selector) => canonicalizeSelector(selector, idFormat))
        .filter((selector): selector is string => Boolean(selector))
    const expectedSet = new Set(normalizedExpected)
    const sections: SummarySection[] = []
    const seen = new Set<string>()
    const duplicates: string[] = []
    const empty: string[] = []

    for (let index = 0; index < matches.length; index++) {
        const current = matches[index]!
        if (!expectedSet.has(current.selector)) {
            continue
        }
        if (seen.has(current.selector)) {
            if (!duplicates.includes(current.selector)) {
                duplicates.push(current.selector)
            }
            continue
        }
        seen.add(current.selector)

        const next = matches[index + 1]
        const body = text.slice(current.end, next ? next.start : text.length).trim()
        if (body.length === 0) {
            empty.push(current.selector)
            continue
        }
        sections.push({ selector: current.selector, summary: body })
    }

    const missing = normalizedExpected.filter(
        (selector) => !seen.has(selector) && !empty.includes(selector),
    )
    return { sections, missing, duplicates, empty }
}
