import type { Plugin } from "@opencode/plugin/tui"
import { setup } from "./lib/v2/tui"

export default {
    id: "opencode-dcp-rc",
    setup,
} satisfies Plugin.Definition
