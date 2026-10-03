import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const root =
    process.env.DCP_LAB_DIR ||
    `/tmp/opencode/dcp-lab-rc/${new Date().toISOString().replace(/[:.]/g, "-")}`
const artifacts = join(root, "artifacts")
const runtime = join(root, "runtime")
mkdirSync(artifacts, { recursive: true, mode: 0o700 })
mkdirSync(runtime, { recursive: true, mode: 0o700 })

if (!process.argv.includes("--built")) {
    execFileSync("npm", ["run", "build"], { cwd: repo, stdio: "inherit" })
}
execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", artifacts], {
    cwd: repo,
    stdio: "pipe",
})
console.log(`Lab output: ${root}`)

execFileSync(
    "docker",
    [
        "run",
        "--rm",
        "--init",
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "--mount",
        `type=bind,source=${runtime},target=/lab`,
        "--mount",
        `type=bind,source=${artifacts},target=/artifacts,readonly`,
        "--mount",
        `type=bind,source=${join(repo, "tests/lab")},target=/test,readonly`,
        "dcp-lab:2.0.4",
        "node",
        "/test/rc-run.mjs",
    ],
    { stdio: "inherit" },
)
