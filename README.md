# Desktop Commander Manager

개인 Desktop Commander MCP 터널과 로컬 확장 기능을 관리하는 Windows 앱입니다.

## Install

Download the latest Windows `*-setup.exe` from [Releases](https://github.com/inonego-ai/desktop-commander-manager/releases) when a verified build is available. Install and open **Connection settings**. Provide your own OpenAI Secure MCP Tunnel ID and runtime API key, then select **Connect**. In ChatGPT, add a personal MCP connection using that tunnel (availability depends on your account/workspace). Nothing is uploaded from this application into ChatGPT as a plugin package.

## Features

- Tauri 2 + Rust + Svelte 5 기반 트레이 앱과 크기 조절 가능한 Manager 창
- Full Desktop Commander tool compatibility, including PowerShell and filesystem access
- MCP 프록시가 Desktop Commander 백엔드와 초기화 세션을 직접 관리
- Goal/Plan 전용 기능 없이 향후 MCP 도구를 명시적으로 등록할 수 있는 확장 레지스트리
- 확장 기능 영역을 유지하는 Manager GUI (현재 기본 확장 0개)
- Connect/disconnect tunnel and restart Desktop Commander backend
- Scrollable in-app activity log for connection, restart, settings, and error events, with severity-colored entries
- API key stored in Windows Credential Manager; passed only to the tunnel-client process environment at connection time
- Vendor runtimes bundled in the Windows installer, with third-party license notices; end users do not install Node manually

**API key handling:** the runtime API key is not stored in source, JSON settings, tunnel profiles, or permanent Windows environment variables. When connecting, Manager reads it from Windows Credential Manager and sets `CONTROL_PLANE_API_KEY` only in the child `tunnel-client` environment. Its profile uses `env:CONTROL_PLANE_API_KEY`. The transport proxy removes that variable before spawning Desktop Commander, so normal PowerShell tool calls do not inherit it. A live tunnel process still holds the key in memory: use a runtime key limited to Tunnels **Read + Use**, never an Admin API key. Windows user-level command access is not a security sandbox.

**Security boundary:** remote MCP commands run with the signed-in Windows user's file and process permissions. The manager does not provide a directory allowlist or OS sandbox. Only connect tunnels you control; disconnect when not in use. Restarting Desktop Commander interrupts in-flight work. Connection settings for this version are stored in per-user connection.json.

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
