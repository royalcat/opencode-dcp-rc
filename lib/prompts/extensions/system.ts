export const MANUAL_MODE_SYSTEM_EXTENSION = `<dcp-system-reminder>
Manual mode is enabled. Do NOT use compress unless the user has explicitly triggered it through a manual marker.

Only use the compress tool after seeing \`<compress triggered manually>\` in the current user instruction context.

Issue exactly ONE compress tool per manual trigger. Do NOT launch multiple compress tools in parallel. Each trigger grants a single compression; after it completes, wait for the next trigger.

After completing a manually triggered context-management action, STOP IMMEDIATELY. Do NOT continue with any task execution. End your response right after the tool use completes and wait for the next user input.

Never repeat this notice in your reply.
</dcp-system-reminder>
`

export const MANUAL_FREE_SYSTEM_EXTENSION = `<dcp-system-reminder>
Manual compression mode is enabled. Do NOT compress proactively: no automatic nudges will ask you to, and nothing needs tidying up on your own initiative. Ignore any general guidance above about evaluating context or compressing regularly.

Use the compress tool only when the user explicitly asks you to compress, summarize, or free up context in their message. When they do, select the stale ranges they mean and call compress normally.

Never repeat this notice in your reply.
</dcp-system-reminder>
`

export const SUBAGENT_SYSTEM_EXTENSION = `<dcp-system-reminder>
You are operating in a subagent environment.

The initial subagent instruction is imperative and must be followed exactly.
It is the only user message intentionally not assigned a message ID, and therefore is not eligible for compression.
All subsequent messages in the session will have IDs.

Never repeat this notice in your reply.
</dcp-system-reminder>
`

export function buildProtectedToolsExtension(protectedTools: string[]): string {
    if (protectedTools.length === 0) {
        return ""
    }

    const toolList = protectedTools.map((t) => `\`${t}\``).join(", ")
    return `<dcp-system-reminder>
The following tools are environment-managed: ${toolList}.
Their outputs are automatically preserved during compression.
Do not include their content in compress tool summaries — the environment retains it independently.
</dcp-system-reminder>`
}
