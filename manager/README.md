# Desktop Commander Manager — Windows app

The Windows UI lives in this manager/ directory. See the repository README for installation and build instructions.

Runtime: Tauri 2 + Rust + Svelte 5, OpenAI tunnel-client, bundled Node.js, the MCP transport proxy in ../src/MCPStdioProxy.mjs, and Desktop Commander. The transport proxy directly supervises Desktop Commander and keeps the tunnel-facing MCP session stable across backend restarts.

Prepare-Release.ps1 stages verified Windows tunnel-client and Node archives, installs the pinned Desktop Commander runtime, patches a known stream cleanup issue, and copies the MCP transport proxy. Check-Release.mjs prevents accidental inclusion of credentials.

Control-plane API keys are stored in Windows Credential Manager. Per-user connection.json holds only the tunnel and optional organization IDs; credentials and generated profiles are never part of source control. Tunnel-client receives its runtime key in its child-only CONTROL_PLANE_API_KEY environment variable; MCPStdioProxy removes that value before spawning Desktop Commander. Use a Tunnels Read + Use runtime key, not an Admin API key.

Security model: remote commands, including PowerShell and filesystem operations, execute with the signed-in Windows user's permissions. No directory allowlist or OS sandbox is imposed. Disconnect the tunnel when remote access is unnecessary. Restart DC interrupts in-flight work but keeps the tunnel alive.


## 확장 기능

Manager의 **확장 기능 영역**은 유지합니다. 현재 기본 제공되는 Goal/Plan 확장은 없습니다.

MCP 프록시는 `src/extensions/registry.mjs`의 확장 레지스트리를 사용합니다.
승인된 새로운 확장은 `src/extensions/index.mjs`에서 명시적으로 등록하고,
도구 목록과 `tools/call` 처리는 기존 터널 연결을 유지한 채 확장할 수 있습니다.
임의의 로컬 스크립트를 자동 탐색하거나 실행하지는 않습니다.

기존 Goal/Plan 데이터는 읽거나 수정하지 않으며 업그레이드 과정에서 자동 삭제하지 않습니다.
과거 설치에서 남은 Goal/Plan 실행 모듈이 릴리스에 포함되지 않도록 검사합니다.

**빌드·설치 전 점검 절차:** [RELEASE.md](RELEASE.md)

실행 중인 운영 Manager와 터널은 소스 수정이나 빌드로 교체되지 않습니다.
