# pi-openpets

A Pi extension package for [OpenPets](https://github.com/ninehills/openpets). It mirrors Pi agent lifecycle and tool activity to the local OpenPets desktop pet without exposing OpenPets as an LLM tool.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/ninehills/pi-openpets.git
```

Then restart Pi, or run `/reload` in Pi.

For project-local installation:

```bash
pi install -l git:github.com/ninehills/pi-openpets.git
```

## Requirements

- OpenPets desktop app is already running.
- Pi can connect to the local OpenPets IPC endpoint.

If OpenPets is not running, the extension shows a warning in Pi and continues without blocking the agent.

## What it shows

The extension sends short English status messages to OpenPets:

- Session connected: `OpenPets link established.`
- Thinking: `Thinking...`
- Tool call: `Using bash.` / `Using read.` / etc.
- Tool result: `bash wrapped up.` or `bash stumbled.`
- Assistant response lifecycle: `Drafting a reply...` then `Reply ready.`
- Agent completion: `Mission complete.` then `Back on standby.`
- Shutdown: `Logging off.`

Tool arguments, tool output, model output, prompts, file contents, and command output are not sent to OpenPets.

## Commands

After loading the extension, Pi provides:

```text
/openpets status
/openpets test
```

- `/openpets status` checks the local OpenPets connection.
- `/openpets test` sends a waving test event.

## Development

```bash
npm install
npm run typecheck
```

You can try the local checkout without installing globally:

```bash
pi -e ./extensions/openpets.ts
```

## Package layout

```text
extensions/openpets.ts  # Pi extension entrypoint
package.json            # Pi package manifest
```
