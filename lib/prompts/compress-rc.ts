import type { IdFormat } from "../message-ids"

export function rcPrompt(format: IdFormat = "xml"): string {
    const single = format === "compact" ? "`@4@`" : "`m0004`"
    const block = format === "compact" ? "`@b2@`" : "`b2`"
    const range = format === "compact" ? "`@4@-@8@`" : "`m0004-m0008`"
    return `Compress stale conversation messages into technical summaries.

Pass \`ids\`: an ordered list of injected message IDs, block IDs, or inclusive
ranges. Each list item becomes one summary, so preserve the summary boundaries
you want. For example, {"ids": [${range}, ${single}]} creates one summary for
the range and one for the single message.

Use only IDs visible in the conversation. A compressed block (${block}) can be
used as a boundary: including it merges its summary into the new one and retires
the old block. Prefer one broad, comprehensive selection of stale or resolved
messages over several small calls. Do not compress messages whose exact code,
errors, or file contents may still be needed in the immediate next steps; do not
compress work that is still active.

Prefer to call it right after a user message that starts new work, when earlier
ranges are clearly closed. If the current task is simply ending with no follow-up
expected, there is no later request for the summary to serve, so leaving the
context intact is fine.

The summaries are generated automatically during this tool call and replace the
selected messages in your next request.`
}

export const COMPRESS_RC = rcPrompt()
