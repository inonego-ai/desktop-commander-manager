# Desktop Commander Manager

Compact, dark-mode Windows application for managing a personal Desktop Commander MCP tunnel.

## Install

Download the latest Windows `*-setup.exe` from [Releases](https://github.com/inonego-ai/desktop-commander-manager/releases) when a verified build is available. Install and open **Connection settings**. Provide your own OpenAI Secure MCP Tunnel ID and runtime API key, then select **Connect**. In ChatGPT, add a personal MCP connection using that tunnel (availability depends on your account/workspace). Nothing is uploaded from this application into ChatGPT as a plugin package.

## Features

- Tauri 2 + Rust + Svelte 5 desktop tray app, compact fixed-size dark panel
- Allowed-folder list with square scrollbar and selection-based removal
- Live file-access policy in restricted mode; arbitrary shell/process tools disabled
- Connect/disconnect tunnel and restart Desktop Commander backend
- API key stored in Windows Credential Manager, never in tracked configuration
- Vendor runtimes bundled in the Windows installer, with third-party license notices; end users do not install Node manually

**Security boundary:** allowed folders restrict MCP file tools; this is not a Windows OS sandbox. Unrestricted mode grants file and shell access with the Windows account permissions. Existing in-flight actions may need interruption when access becomes more restrictive.

## Build

Use Windows with Node.js, Rust stable, Microsoft C++ Build Tools and WebView2. Run:

```powershell
cd manager
npm install
./scripts/Prepare-Release.ps1
npm run test:proxy
npm run check:release
npm run check
npm run build
```

Or run the **Windows installer** GitHub Actions workflow manually. A successful workflow provides an installer artifact. A `v*` tag additionally publishes a GitHub Release with the installer. A release should only be tagged after testing the installed app and an actual tunnel connection.

The repository ships source only; no user credentials, local tunnel profiles, personal runtime data or vendor binaries are checked into Git.
