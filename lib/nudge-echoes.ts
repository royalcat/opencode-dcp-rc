/**
 * Removes compression-nudge text that models echo back into visible replies.
 *
 * The nudges are addressed to the model, but weaker models sometimes copy the
 * reminder body into their reply — often without the surrounding
 * `<dcp-system-reminder>` tag and sometimes repeated many times. The tag
 * scrubber in `lib/v2/scrub.ts` cannot see those copies, so this module
 * recognizes the known nudge lines themselves.
 *
 * The patterns are derived from the bundled prompts in `lib/prompts/`, so they
 * stay in sync with the text the plugin actually injects. Custom prompt
 * overrides are still covered by the tag scrubber, but an untagged echo of an
 * overridden prompt is not recognized here.
 */

import { CONTEXT_LIMIT_NUDGE } from "./prompts/context-limit-nudge"
import { ITERATION_NUDGE } from "./prompts/iteration-nudge"
import { TURN_NUDGE } from "./prompts/turn-nudge"
import { GUIDANCE_BLOCK_LIST_PREFIX, GUIDANCE_HEADER } from "./prompts/extensions/nudge"

const DCP_TAG_REGEX = /<\/?dcp[^>]*>/gi

function promptLines(prompt: string): string[] {
    return prompt
        .replace(DCP_TAG_REGEX, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
}

const TURN_LINES = promptLines(TURN_NUDGE)
const ITERATION_LINES = promptLines(ITERATION_NUDGE)
const CONTEXT_LIMIT_LINES = promptLines(CONTEXT_LIMIT_NUDGE)

/** First line of each injected nudge body, matched as a whole line. */
export const NUDGE_HEAD_LINES: readonly string[] = [
    TURN_LINES[0],
    ITERATION_LINES[0],
    CONTEXT_LIMIT_LINES[0],
].filter((line): line is string => typeof line === "string" && line.length > 0)

const HEAD_SET = new Set(NUDGE_HEAD_LINES)

// Weak models sometimes drop the tail of the first bullet; match its stem.
const GUIDANCE_BLOCK_LIST_STEM = "- Active compressed blocks in"

/** Last line of every nudge body (before the appended block guidance). */
export const NUDGE_END_LINE = TURN_LINES[TURN_LINES.length - 1] ?? ""

/** The turn nudge's "keep active context" line; part of the echoed tail. */
export const NUDGE_KEEP_LINE =
    TURN_LINES.find((line) => line === "Keep active context uncompressed.") ?? ""

const MAX_HEAD_LINES = 240

/** True while the held partial line could still become a recognized marker. */
function isPossibleEchoPrefix(text: string): boolean {
    const trimmed = text.trimStart()
    if (trimmed.length === 0) {
        return true
    }
    if (GUIDANCE_HEADER.startsWith(trimmed)) {
        return true
    }
    if (NUDGE_KEEP_LINE && NUDGE_KEEP_LINE.startsWith(trimmed)) {
        return true
    }
    return NUDGE_HEAD_LINES.some((line) => line.startsWith(trimmed))
}

/**
 * Classifies the start of a reminder body: `true` when it is one of our known
 * nudge bodies, `false` when it clearly is not, `undefined` while more text is
 * needed to decide.
 */
export function classifyNudgeBodyPrefix(text: string): boolean | undefined {
    const start = text.search(/\S/)
    if (start === -1) {
        return undefined
    }
    const body = text.slice(start)
    let possible = false
    for (const head of NUDGE_HEAD_LINES) {
        if (body.startsWith(head)) {
            if (body.length === head.length) {
                return undefined
            }
            const next = body[head.length]
            if (next === "\n") {
                return true
            }
            if (next === "\r") {
                if (body.length === head.length + 1) {
                    return undefined
                }
                return body[head.length + 1] === "\n" ? true : false
            }
            return false
        }
        if (head.startsWith(body)) {
            possible = true
        }
    }
    return possible ? undefined : false
}

type EchoState = "text" | "head" | "guidanceStart" | "guidanceBody" | "keep"

/**
 * Line-based nudge-echo remover. A known nudge head switches the stripper into
 * drop mode through the reminder end line; block guidance is recognized by its
 * header plus the first bullet. Partial lines are held so chunk boundaries do
 * not matter. Unknown text always fails open.
 */
export class NudgeEchoStripper {
    private carry = ""
    private buffer: string[] = []
    private state: EchoState = "text"

    push(chunk: string): string {
        if (!chunk) {
            return ""
        }
        this.carry += chunk
        let out = ""
        for (;;) {
            const newline = this.carry.indexOf("\n")
            if (newline === -1) {
                break
            }
            const line = this.carry.slice(0, newline + 1)
            this.carry = this.carry.slice(newline + 1)
            out += this.consume(line, true)
        }
        if (this.state === "text" && this.carry.length > 0 && !isPossibleEchoPrefix(this.carry)) {
            out += this.carry
            this.carry = ""
        }
        return out
    }

    flush(): string {
        let out = ""
        if (this.carry.length > 0) {
            out += this.consume(this.carry, false)
            this.carry = ""
        }
        if (this.state === "head") {
            // A recognized nudge whose end line never arrived: the body is ours.
            this.buffer = []
        } else if (this.state === "guidanceStart" || this.state === "keep") {
            out += this.buffer.join("")
        }
        this.buffer = []
        this.state = "text"
        return out
    }

    reset(): void {
        this.carry = ""
        this.buffer = []
        this.state = "text"
    }

    private consume(raw: string, terminated: boolean): string {
        const line = terminated && raw.endsWith("\n") ? raw.slice(0, -1) : raw
        const text = line.trim()
        switch (this.state) {
            case "text":
                if (HEAD_SET.has(text)) {
                    this.buffer = [raw]
                    this.state = "head"
                    return ""
                }
                if (text === GUIDANCE_HEADER) {
                    this.buffer = [raw]
                    this.state = "guidanceStart"
                    return ""
                }
                if (NUDGE_KEEP_LINE && text === NUDGE_KEEP_LINE) {
                    this.buffer = [raw]
                    this.state = "keep"
                    return ""
                }
                return raw
            case "head":
                return this.headLine(raw, text, terminated)
            case "guidanceStart":
                return this.guidanceStartLine(raw, text, terminated)
            case "guidanceBody":
                return this.guidanceBodyLine(raw, text, terminated)
            case "keep":
                return this.keepLine(raw, text, terminated)
        }
    }

    private headLine(raw: string, text: string, terminated: boolean): string {
        if (text === NUDGE_END_LINE) {
            this.buffer = []
            this.state = "text"
            return ""
        }
        if (text === GUIDANCE_HEADER) {
            // The end line was lost but the head is unmistakably ours.
            this.buffer = [raw]
            this.state = "guidanceStart"
            return ""
        }
        this.buffer.push(raw)
        if (this.buffer.length > MAX_HEAD_LINES) {
            // Runaway echo without an end line: drop the body, keep going.
            this.buffer = []
            this.state = "text"
        }
        return ""
    }

    private guidanceStartLine(raw: string, text: string, terminated: boolean): string {
        if (text === "") {
            this.buffer.push(raw)
            return ""
        }
        if (
            text.startsWith(GUIDANCE_BLOCK_LIST_PREFIX) ||
            text.startsWith(GUIDANCE_BLOCK_LIST_STEM)
        ) {
            this.buffer = []
            this.state = "guidanceBody"
            return ""
        }
        const pending = this.buffer.join("")
        this.buffer = []
        this.state = "text"
        return pending + this.consume(raw, terminated)
    }

    private guidanceBodyLine(raw: string, text: string, terminated: boolean): string {
        if (
            text === "" ||
            text === NUDGE_KEEP_LINE ||
            text === NUDGE_END_LINE ||
            text.startsWith("- ")
        ) {
            return ""
        }
        this.state = "text"
        return this.consume(raw, terminated)
    }

    private keepLine(raw: string, text: string, terminated: boolean): string {
        if (text === "") {
            this.buffer.push(raw)
            return ""
        }
        if (text === NUDGE_END_LINE) {
            this.buffer = []
            this.state = "text"
            return ""
        }
        const pending = this.buffer.join("")
        this.buffer = []
        this.state = "text"
        return pending + this.consume(raw, terminated)
    }
}

/** Stateless helper for complete text blocks. */
export function stripNudgeEchoes(text: string): string {
    if (!text) {
        return text
    }
    const scrubber = new NudgeEchoStripper()
    return scrubber.push(text) + scrubber.flush()
}
