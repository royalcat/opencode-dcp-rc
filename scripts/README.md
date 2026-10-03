# DCP Prompt Preview CLI

Dev tool for previewing prompt outputs.

## Usage

```bash
npm run dcp -- [options]
```

## Options

| Flag                | Description                           |
| ------------------- | ------------------------------------- |
| `--list`            | List available prompt keys            |
| `--show <key>`      | Print effective prompt text for a key |
| `--system`          | System prompt with no extensions      |
| `--system-manual`   | System prompt with manual extension   |
| `--system-subagent` | System prompt with subagent extension |
| `--system-all`      | System prompt with both extensions    |

## Prompt keys

`system`, `compress-rc`, `context-limit-nudge`, `turn-nudge`, `iteration-nudge`

## Examples

```bash
npm run dcp -- --list
npm run dcp -- --show compress-rc
npm run dcp -- --system-all
```

## Purpose

This CLI does not ship with the plugin. It is for local DX while iterating on injected prompts.
