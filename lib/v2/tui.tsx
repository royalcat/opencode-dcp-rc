/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { ContextDialog, PanelDialog, StatsDialog, StatusDialog } from "../tui/dialogs"
import type { ViewApi } from "../tui/types"
import { rpc } from "./rpc"
import { panelTheme } from "./theme"

export async function setup(ctx: Plugin.Context) {
    const client = ctx.client.rpc(rpc)
    const options = () => ({ location: ctx.location ?? ctx.data.location.default() })
    if (!(await client.status({}, options())).enabled) return
    const api: ViewApi = {
        renderer: ctx.renderer,
        theme: {
            get current() {
                return panelTheme(ctx.theme)
            },
        },
        ui: { dialog: { clear: () => ctx.ui.dialog.clear() } },
    }
    function show(render: Parameters<typeof ctx.ui.dialog.show>[0]) {
        ctx.ui.dialog.set({ size: "xlarge" })
        ctx.ui.dialog.show(render)
    }
    function passiveMessage(passive: boolean, source: "config" | "session"): string {
        const mode = passive ? "passive (nudges off)" : "enabled (nudges on)"
        const origin = source === "session" ? "session override" : "config default"
        return `${mode}\n\nSource: ${origin}`
    }
    function parsePassiveInput(
        input: string,
    ): "status" | "on" | "off" | "reset" | "invalid" | null {
        const [command, action] = input.trim().toLowerCase().split(/\s+/)
        if (command !== "passive") return null
        if (!action || action === "status") return "status"
        if (action === "on" || action === "off" || action === "reset") return action
        return "invalid"
    }
    async function runPassive(
        sessionID: string,
        action: "status" | "on" | "off" | "reset" | "invalid",
    ) {
        if (action === "invalid") {
            show(() => (
                <StatusDialog
                    api={api}
                    title="Passive mode"
                    eyebrow="DCP"
                    message="Usage: /dcp passive [on|off|reset]"
                />
            ))
            return
        }
        const result =
            action === "status"
                ? await client.snapshot({ sessionID }, options())
                : await client.setPassive({ sessionID, mode: action }, options())
        show(() => (
            <StatusDialog
                api={api}
                title="Passive mode"
                eyebrow="DCP"
                message={passiveMessage(result.passiveMode, result.passiveModeSource)}
            />
        ))
    }
    async function togglePassive(sessionID: string, passiveMode: boolean) {
        await client.setPassive({ sessionID, mode: passiveMode ? "off" : "on" }, options())
        await open()
    }
    async function open(page: "panel" | "context" | "stats" = "panel") {
        const route = ctx.ui.router.current()
        if (route.type !== "session") {
            show(() => (
                <StatusDialog
                    api={api}
                    title="DCP"
                    eyebrow="No session"
                    message="Open a session first."
                />
            ))
            return
        }
        const sessionID = route.sessionID
        try {
            const data = await client.snapshot({ sessionID }, options())
            const back = () => {
                void open()
            }
            if (page === "context")
                show(() => <ContextDialog api={api} breakdown={data.context} onBack={back} />)
            else if (page === "stats")
                show(() => <StatsDialog api={api} report={data.stats} onBack={back} />)
            else
                show(() => (
                    <PanelDialog
                        api={api}
                        passiveMode={data.passiveMode}
                        passiveModeSource={data.passiveModeSource}
                        canCompress={data.canCompress}
                        blockedReason={data.blockedReason}
                        onContext={() => {
                            void open("context")
                        }}
                        onStats={() => {
                            void open("stats")
                        }}
                        onTogglePassive={() => {
                            void togglePassive(sessionID, data.passiveMode).catch(error)
                        }}
                    />
                ))
        } catch (cause) {
            error(cause)
        }
    }
    function error(cause: unknown) {
        const message =
            cause instanceof Error
                ? cause.message
                : typeof cause === "object" && cause && "message" in cause
                  ? String(cause.message)
                  : String(cause)
        show(() => <StatusDialog api={api} title="DCP" eyebrow="DCP Error" message={message} />)
    }
    ctx.ui.slot({
        append: "app",
        render() {
            ctx.keymap.layer(() => ({
                mode: "global",
                commands: [
                    {
                        id: "dcp.panel",
                        title: "DCP",
                        description: "Open DCP panel",
                        group: "DCP",
                        palette: true,
                        slash: { name: "dcp", arguments: true },
                        run: async (input) => {
                            if (!input?.trim()) return open()
                            const route = ctx.ui.router.current()
                            if (route.type !== "session") return open()
                            try {
                                const passive = parsePassiveInput(input)
                                if (passive) {
                                    await runPassive(route.sessionID, passive)
                                    return
                                }
                                await ctx.client.session.command({
                                    sessionID: route.sessionID,
                                    name: "dcp",
                                    text: input,
                                })
                            } catch (cause) {
                                error(cause)
                            }
                        },
                    },
                ],
            }))
            return null
        },
    })
}
