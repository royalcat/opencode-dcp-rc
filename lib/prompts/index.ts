import type { RuntimePrompts } from "./store"
import type { ManualCompressionMode } from "../compress-permission"
export type { PromptStore, RuntimePrompts } from "./store"

export function renderSystemPrompt(
    prompts: RuntimePrompts,
    protectedToolsExtension?: string,
    manual: ManualCompressionMode = "off",
    subagent?: boolean,
): string {
    const extensions: string[] = []

    if (protectedToolsExtension) {
        extensions.push(protectedToolsExtension.trim())
    }

    if (manual === "free") {
        extensions.push(prompts.manualFreeExtension.trim())
    } else if (manual === "trigger-required") {
        extensions.push(prompts.manualExtension.trim())
    }

    if (subagent) {
        extensions.push(prompts.subagentExtension.trim())
    }

    return [prompts.system.trim(), ...extensions]
        .filter(Boolean)
        .join("\n\n")
        .replace(/\n([ \t]*\n)+/g, "\n\n")
        .trim()
}
