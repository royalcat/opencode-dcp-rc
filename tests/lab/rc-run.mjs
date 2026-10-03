import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createMock } from "./mock.mjs"
import { run } from "./process.mjs"

const artifacts = await readdir("/artifacts")
const dcpTgz = artifacts.find(
    (name) => name.startsWith("royalcat-opencode-dcp-rc") && name.endsWith(".tgz"),
)
assert.ok(dcpTgz, "royalcat-opencode-dcp-rc tarball not found in /artifacts")

await run("npm", [
    "install",
    "--prefix",
    "/lab/plugins",
    "--omit=dev",
    "--ignore-scripts",
    join("/artifacts", dcpTgz),
    "ws",
])
const dcp = "/lab/plugins/node_modules/@royalcat/opencode-dcp-rc"
const require = createRequire(join("/lab/plugins", "package.json"))
const { WebSocketServer } = require("ws")
const mock = await createMock(WebSocketServer)

try {
    const root = "/lab/rc"
    const directory = join(root, "project")
    const config = join(root, "config", "opencode")
    const logs = join(root, "logs")
    await Promise.all([directory, config, logs].map((path) => mkdir(path, { recursive: true })))

    await writeFile(
        join(config, "opencode.json"),
        JSON.stringify({
            plugins: [{ package: dcp }],
            update: "disable",
            model: "lab/gpt-5.4",
            permissions: [{ action: "compress", resource: "*", effect: "allow" }],
            providers: {
                lab: {
                    package: "@opencode/ai/providers/openai/responses",
                    env: ["LAB_API_KEY"],
                    settings: { baseURL: mock.url },
                    models: {
                        "gpt-5.4": {
                            transport: "http",
                            compaction: { mode: "local" },
                            limit: { context: 200000, output: 32000 },
                        },
                    },
                },
            },
        }),
    )
    await writeFile(
        join(config, "dcp-rc.json"),
        JSON.stringify({
            debug: true,
            pruneNotification: "off",
            compress: { mode: "rc" },
        }),
    )

    const env = {
        ...process.env,
        HOME: root,
        PWD: directory,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
        OPENCODE_CONFIG_DIR: config,
        LAB_API_KEY: "lab",
        OPENCODE_LOG_LEVEL: "DEBUG",
    }
    const cli = "/opt/v2/node_modules/.bin/opencode2"

    const start1 = mock.requests.length
    const first = await run(
        cli,
        [
            "run",
            "--standalone",
            "--format",
            "json",
            "--model",
            "lab/gpt-5.4",
            "OLD_PAYLOAD: This completed material can be compressed. Then reply with MOCK_OK.",
        ],
        { cwd: directory, env, record: join(root, "run1") },
    )
    assert.ok(first.includes("MOCK_OK"), "first run did not return the mock response")

    const sent1 = mock.requests.slice(start1).filter((request) => request.transport === "http")
    await writeFile(join(root, "debug-requests-run1.json"), JSON.stringify(sent1, null, 2))
    await writeFile(join(root, "debug-mock-run1.json"), JSON.stringify(mock.debug, null, 2))
    const summaryRequest = sent1.find((request) =>
        JSON.stringify(request.body).includes("[[DCP-RC-SUMMARY"),
    )
    assert.ok(summaryRequest, "hidden summary request was not issued")

    const start2 = mock.requests.length
    const second = await run(
        cli,
        [
            "run",
            "--standalone",
            "--continue",
            "--format",
            "json",
            "--model",
            "lab/gpt-5.4",
            "Follow-up after compression. Reply with MOCK_OK.",
        ],
        { cwd: directory, env, record: join(root, "run2") },
    )
    assert.ok(second.includes("MOCK_OK"), "second run did not return the mock response")

    const sent2 = mock.requests.slice(start2).filter((request) => request.transport === "http")
    await writeFile(join(root, "debug-requests-run2.json"), JSON.stringify(sent2, null, 2))
    await writeFile(join(root, "debug-mock-run2.json"), JSON.stringify(mock.debug, null, 2))
    const primary2 = sent2.filter((request) =>
        request.body.tools?.some((tool) => tool.name === "compress"),
    )
    assert.ok(primary2.length > 0, "no primary request captured in the second run")
    const wire2 = JSON.stringify(primary2[0].body.input)
    assert.match(wire2, /LAB_SUMMARY/, "compressed summary missing from the second run context")
    assert.ok(
        !wire2.includes("OLD_PAYLOAD"),
        "compressed source is still present in the second run",
    )

    // Transparency: the compress tool call is visible, the hidden prompt is not.
    const visible = `${first}\n${second}`
    assert.match(visible, /compress/, "compress tool call is not visible in the CLI output")
    assert.ok(!visible.includes("SLEEV-SUMMARY"), "hidden summary prompt leaked into user output")
    assert.ok(!visible.includes("[[DCP-RC-SUMMARY"), "hidden marker leaked into user output")

    // Compression-request usage: provider telemetry from the mock is authoritative.
    const stateDir = join(root, "data", "opencode", "storage", "plugin", "dcp")
    const stateFiles = await readdir(stateDir)
    const usage = stateFiles.length
        ? (JSON.parse(await readFile(join(stateDir, stateFiles[0]), "utf8"))?.stats
              ?.compressionUsage ?? null)
        : null
    assert.ok(usage, "compression usage was not persisted")
    assert.ok(usage.calls >= 1, "no compression requests were recorded")
    assert.ok(usage.inputTokens > 0, "no compression input tokens were recorded")
    assert.ok(usage.outputTokens > 0, "no compression output tokens were recorded")
    assert.equal(
        usage.providerCalls,
        usage.calls,
        "compression usage was not captured from provider telemetry",
    )
    assert.equal(usage.inputTokens, 100 * usage.calls)
    assert.equal(usage.outputTokens, 5 * usage.calls)

    console.log(
        JSON.stringify({
            mode: "rc",
            hiddenSummaryRequest: true,
            compressionApplied: true,
            summaryRequestHasNoTools: !summaryRequest.body.tools?.length,
            primaryRequestsRun1: sent1.filter((request) =>
                request.body.tools?.some((tool) => tool.name === "compress"),
            ).length,
            primaryRequestsRun2: primary2.length,
            compressionUsage: usage,
        }),
    )
} finally {
    await mock.close()
}
