# Desktop Commander Manager — Windows app

This directory contains the Windows application. For installation, usage, and security guidance, see the [project README](../README.md).

## Project layout

- `src/` — connection controls and activity view.
- `src-tauri/` — application lifecycle, tunnel settings, and credentials.
- `scripts/` — runtime preparation and release checks.
- `../src/MCPStdioProxy.mjs` — MCP transport and Desktop Commander backend supervision.

## Extensions

Additional MCP tools can be registered explicitly in `../src/extensions/index.mjs`. No extensions are included by default, and the app does not discover or run arbitrary local scripts.

## Release

See the [release guide](RELEASE.md) for build, verification, and packaging instructions.
