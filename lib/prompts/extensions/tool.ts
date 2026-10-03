// These format schemas are kept separate from the editable compress prompts
// so they cannot be modified via custom prompt overrides. The schemas must
// match the tool's input validation and are not safe to change independently.

import type { IdFormat } from "../../message-ids"

export function rcFormat(format: IdFormat = "xml"): string {
    const single = format === "compact" ? "@4@" : "m0004"
    const block = format === "compact" ? "@b2@" : "b2"
    const range = format === "compact" ? "@4@-@8@" : "m0004-m0008"
    return `
THE FORMAT OF COMPRESS

\`\`\`
{
  ids: string[]   // Injected message IDs, block IDs, or inclusive ranges; each item becomes one summary
}
\`\`\`

Examples: \`{"ids": ["${range}", "${single}"]}\` creates one summary for the range and a separate summary for the single message. \`{"ids": ["${block}"]}\` merges an existing compressed block into a new summary.`
}
