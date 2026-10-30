# Desktop Commander Manager

![Windows](https://img.shields.io/badge/Platform-Windows-0078D4?logo=windows&logoColor=white)
![MCP Tunnel](https://img.shields.io/badge/Connection-MCP%20Tunnel-6855D6)
[![Releases](https://img.shields.io/badge/Download-Releases-238636?logo=github&logoColor=white)](https://github.com/inonego-ai/desktop-commander-manager/releases)

**Connect ChatGPT to Desktop Commander on your Windows PC through a personal MCP tunnel.** Manage the connection from a simple desktop app.

## Features

- Connect and disconnect your MCP tunnel.
- Restart Desktop Commander without dropping the tunnel connection.
- View connection status and recent activity.
- Keep the app running in the system tray when the window is closed.
- Store the runtime API key securely in Windows Credential Manager.

## Getting started

1. Download a Windows `*-setup.exe` installer from [Releases](https://github.com/inonego-ai/desktop-commander-manager/releases), if available, and install it.
2. Open **Connection settings** and enter your tunnel ID, runtime API key, and optional organization ID.
3. Save the settings, select **Connect**, and wait for **Connected**.
4. In ChatGPT, add a personal MCP connection using your tunnel (subject to account and workspace availability).

## Security

Desktop Commander tools run with your Windows account's permissions. **There is no filesystem allowlist or OS sandbox.** Only connect tunnels you control, and disconnect when not in use.

Use a runtime API key with **Tunnels: Read + Use** permissions, not an Admin API key. The key is kept in Windows Credential Manager rather than the connection settings file.

## Build from source

On Windows, with Node.js, Rust, Microsoft C++ Build Tools, and WebView2 installed:

```powershell
cd manager
npm install
.\scripts\Prepare-Release.ps1
npm run test:proxy
npm run build
```

See the [release guide](manager/RELEASE.md) for additional checks and packaging details.
