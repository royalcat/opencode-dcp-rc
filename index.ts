import type { Plugin } from "@opencode/plugin"
import { setup } from "./lib/v2"

export default {
    id: "opencode-dcp-rc",
    setup,
} satisfies Plugin.Plugin
