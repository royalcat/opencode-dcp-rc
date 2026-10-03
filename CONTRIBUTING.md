# Contributing to DCP-RC

Thank you for your interest in contributing to @royalcat/opencode-dcp-rc!

## License and Contributions

This project uses the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

### Contribution Agreement

By submitting a Pull Request to this project, you agree that:

1.  Your contributions are licensed under the **AGPL-3.0**.
2.  You grant the project maintainer(s) a non-exclusive, perpetual, irrevocable, worldwide, royalty-free, transferable license to use, modify, and re-license your contributions under any terms they choose, including commercial or proprietary licenses.

This arrangement ensures the project remains Open Source while providing a path for commercial sustainability.

## Getting Started

1.  Fork the repository.
2.  Create a feature branch.
3.  Implement your changes and add tests if applicable (please NO AI SLOP).
4.  Ensure all tests pass and the code is formatted.
5.  Submit a Pull Request.

## Development Setup

Use Node.js and npm. From your checkout:

```sh
npm ci --legacy-peer-deps
npm run build
```

The install flag allows development against the different OpenTUI peer versions
used by OpenCode V1 and V2. This also installs the bundled test logger's
dependencies through the [tests/logger](tests/logger/) npm workspace.

Run the checks relevant to your changes before submitting a pull request:

```sh
npm test                  # DCP-RC and request-logger tests
npm run typecheck         # TypeScript validation
npm run check:package     # Build and validate the npm package
npm run format:check      # Formatting
```

## Compatibility

This fork targets **OpenCode V2 only** (`@opencode/plugin` ^2.0.22) and ships a
single compression mode: selection-only `rc` compression with mid-turn hidden
summaries. The upstream `range`/`message` modes and V1 support were removed in
4.0.0.

Use [package.json](package.json) for dependency requirements and
[the lab Dockerfile](tests/lab/Dockerfile) for the pinned integration-test
version. Host-specific behavior is implemented in [index.ts](index.ts),
[tui.tsx](tui.tsx), and [lib/v2/](lib/v2/).

V2 uses compact message IDs (`@N@`), block IDs (`@bN@`), and `@blocked@` for
protected user messages; the plugin normalizes both ID formats internally. The
hidden summary request and its parsing live in
[lib/compress/summary.ts](lib/compress/summary.ts).

## Local Installation

After building, add this checkout's absolute path to your OpenCode `opencode.json`:

```jsonc
{
    "plugins": [{ "package": "/absolute/path/to/opencode-dcp-rc" }],
    "permissions": [{ "action": "compress", "resource": "*", "effect": "allow" }],
}
```

## Integration Tests

The containerized `lab:rc` scenario exercises the packed plugin against a local
mock provider without live credentials. It builds the fork, packs it, and runs
[tests/lab/rc-run.mjs](tests/lab/rc-run.mjs) inside the lab image.

After [Development Setup](#development-setup), build the image tag expected by
[scripts/lab-rc.mjs](scripts/lab-rc.mjs):

```sh
docker build -t dcp-lab:2.0.4 tests/lab
npm run lab:rc
```

The runner prints its output directory under `/tmp/opencode/dcp-lab-rc/`. Set
`DCP_LAB_DIR` to override it. Add `--built` to reuse an existing DCP build.

The scenario asserts that the hidden summary request is issued, carries no
tools, is applied within the same turn, and that neither the marker nor the
summary prompt leaks into user-visible output. Captured requests and mock
responses are written to `debug-requests-run*.json` / `debug-mock-run*.json`
in the run directory.
