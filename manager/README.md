# Desktop Commander Manager — Windows app

The Windows UI lives in this `manager/` directory. See the [repository README](../README.md) for installation and build instructions.

**Runtime composition:** Tauri 2 + Rust + Svelte 5, OpenAI `tunnel-client`, a bundled Node.js runtime, an MCP transport proxy in `../src/MCPStdioProxy.mjs`, `PolicyProxy.mjs`, and Desktop Commander.

`Prepare-Release.ps1` stages verified Windows tunnel-client and Node archives, installs the pinned Desktop Commander runtime, patches the known partial-read stream cleanup issue, and copies the MCP transport proxy. `Check-Release.mjs` checks for accidental credentials in the staged bundle.

API keys are stored in Windows Credential Manager. The per-user settings JSON holds the nonsecret tunnel ID and allowlist; no `.env`, key or generated tunnel profile is part of Git.

Allowed folders filter MCP requests, not OS-level file system access. Restricted mode blocks command and process tools. Mode and allowlist updates apply to new requests without restarting the full tunnel. In-progress operations may be interrupted on revocation.
