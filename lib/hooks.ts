import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { renderSystemPrompt, type PromptStore } from "./prompts"
import { buildProtectedToolsExtension } from "./prompts/extensions/system"
import { filterMessages } from "./messages/shape"
import {
    handleContextCommand,
    handleDecompressCommand,
    handleHelpCommand,
    handleManualToggleCommand,
    handleManualTriggerCommand,
    handleRecompressCommand,
    handleStatsCommand,
    handleSweepCommand,
} from "./commands"
import { compressPermission } from "./compress-permission"
import { ensureSessionInitialized } from "./state"

const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "You are an anchored context summarization assistant for coding sessions",
    "Summarize what was done in this conversation",
]

function isInternalAgentCall(systemPrompts: string[]): boolean {
    const primaryPrompt = systemPrompts[0]
    if (typeof primaryPrompt !== "string" || primaryPrompt.length === 0) {
        return false
    }

    return INTERNAL_AGENT_SIGNATURES.some((signature) => primaryPrompt.includes(signature))
}

export function createSystemPromptHandler(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
) {
    return async (
        input: { sessionID?: string; model: { limit: { context: number } } },
        output: { system: string[] },
    ) => {
        if (input.model?.limit?.context) {
            state.modelContextLimit = input.model.limit.context
            logger.debug("Cached model context limit", { limit: state.modelContextLimit })
        }

        if (state.isSubAgent && !config.experimental.allowSubAgents) {
            return
        }

        if (isInternalAgentCall(output.system)) {
            logger.info("Skipping DCP system prompt injection for internal agent")
            return
        }

        const effectivePermission =
            input.sessionID && state.sessionId === input.sessionID
                ? compressPermission(state, config)
                : config.compress.permission

        if (effectivePermission === "deny") {
            return
        }

        prompts.reload()
        const runtimePrompts = prompts.getRuntimePrompts()
        const newPrompt = renderSystemPrompt(
            runtimePrompts,
            buildProtectedToolsExtension(config.compress.protectedTools),
            !!state.manualMode,
            state.isSubAgent && config.experimental.allowSubAgents,
        )
        if (output.system.length > 0) {
            output.system[output.system.length - 1] += "\n\n" + newPrompt
        } else {
            output.system.push(newPrompt)
        }
    }
}

export function createCommandExecuteHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: any[] },
    ) => {
        if (!config.commands.enabled) {
            return
        }

        if (input.command === "dcp" || input.command === "dcp-compress") {
            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            })
            const messages: WithParts[] = filterMessages(messagesResponse.data || messagesResponse)

            await ensureSessionInitialized(
                client,
                state,
                input.sessionID,
                logger,
                messages,
                config.manualMode.enabled,
            )

            const effectivePermission = compressPermission(state, config)
            if (effectivePermission === "deny") {
                return
            }

            const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
            const isCompressCommand = input.command === "dcp-compress"
            const subcommand = isCompressCommand ? "compress" : args[0]?.toLowerCase() || ""
            const subArgs = isCompressCommand ? args : args.slice(1)

            const commandCtx = {
                client,
                state,
                config,
                logger,
                sessionId: input.sessionID,
                messages,
            }

            if (subcommand === "context") {
                await handleContextCommand(commandCtx)
                return
            }

            if (subcommand === "stats") {
                await handleStatsCommand(commandCtx)
                return
            }

            if (subcommand === "sweep") {
                await handleSweepCommand({
                    ...commandCtx,
                    args: subArgs,
                    workingDirectory,
                })
                return
            }

            if (subcommand === "manual") {
                await handleManualToggleCommand(commandCtx, subArgs[0]?.toLowerCase())
                return
            }

            if (subcommand === "compress") {
                const userFocus = subArgs.join(" ").trim()
                const prompt = await handleManualTriggerCommand(commandCtx, "compress", userFocus)
                if (!prompt) {
                    throw new Error("__DCP_MANUAL_TRIGGER_BLOCKED__")
                }

                state.manualMode = "compress-pending"
                state.pendingManualTrigger = {
                    sessionId: input.sessionID,
                    prompt,
                }
                const rawArgs = (input.arguments || "").trim()
                output.parts.length = 0
                output.parts.push({
                    type: "text",
                    text: isCompressCommand
                        ? rawArgs
                            ? `/dcp-compress ${rawArgs}`
                            : "/dcp-compress"
                        : rawArgs
                          ? `/dcp ${rawArgs}`
                          : `/dcp ${subcommand}`,
                })
                return
            }

            if (subcommand === "decompress") {
                await handleDecompressCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                return
            }

            if (subcommand === "recompress") {
                await handleRecompressCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                return
            }

            await handleHelpCommand(commandCtx)
            return
        }
    }
}
