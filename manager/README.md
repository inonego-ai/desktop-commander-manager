# Desktop Commander Manager — Windows app

The Windows UI lives in this manager/ directory. See the repository README for installation and build instructions.

Runtime: Tauri 2 + Rust + Svelte 5, OpenAI tunnel-client, bundled Node.js, the MCP transport proxy in ../src/MCPStdioProxy.mjs, and Desktop Commander. The transport proxy directly supervises Desktop Commander and keeps the tunnel-facing MCP session stable across backend restarts.

Prepare-Release.ps1 stages verified Windows tunnel-client and Node archives, installs the pinned Desktop Commander runtime, patches a known stream cleanup issue, and copies the MCP transport proxy. Check-Release.mjs prevents accidental inclusion of credentials.

Control-plane API keys are stored in Windows Credential Manager. Per-user connection.json holds only the tunnel and optional organization IDs; credentials and generated profiles are never part of source control. Tunnel-client receives its runtime key in its child-only CONTROL_PLANE_API_KEY environment variable; MCPStdioProxy removes that value before spawning Desktop Commander. Use a Tunnels Read + Use runtime key, not an Admin API key.

Security model: remote commands, including PowerShell and filesystem operations, execute with the signed-in Windows user's permissions. No directory allowlist or OS sandbox is imposed. Disconnect the tunnel when remote access is unnecessary. Restart DC interrupts in-flight work but keeps the tunnel alive.
