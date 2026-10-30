use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WindowEvent,
};

const KEY_SERVICE: &str = "ai.inonego.commander-manager.control-plane";
const KEY_ACCOUNT: &str = "current-user";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    tunnel_id: String,
    organization_id: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self { tunnel_id: String::new(), organization_id: String::new() }
    }
}

#[derive(Serialize)]
struct Status {
    running: bool,
    ready: bool,
    tunnel_id: String,
    organization_id: String,
    has_key: bool,
    runtime_ready: bool,
    runtime_message: String,
    connection_issue: Option<String>,
}

struct CommanderState {
    config: Mutex<Settings>,
    process: Mutex<Option<Child>>,
    data_dir: PathBuf,
    resource_dir: PathBuf,
    log_start: Mutex<Option<u64>>,
}

impl CommanderState {
    fn settings_path(&self) -> PathBuf { self.data_dir.join("connection.json") }
    fn restart_trigger(&self) -> PathBuf { self.data_dir.join("backend-restart.request") }
    fn tunnel_log(&self) -> PathBuf { self.data_dir.join("logs").join("tunnel.log") }

    fn connection_issue(&self) -> Option<String> {
        let baseline = (*self.log_start.lock().ok()?)?;
        recent_connection_issue(&self.tunnel_log(), baseline)
    }

    fn save_config(&self, config: &Settings) -> Result<(), String> {
        let serialized = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
        let pending = self.settings_path().with_extension("tmp");
        fs::write(&pending, serialized).map_err(|e| e.to_string())?;
        fs::rename(pending, self.settings_path()).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn signal_restart(&self) -> Result<(), String> {
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?.as_nanos();
        fs::write(self.restart_trigger(), timestamp.to_string()).map_err(|e| e.to_string())
    }

    fn runtime_files(&self) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let runtime = self.resource_dir.join("runtime");
        (
            runtime.join("tunnel-client.exe"),
            runtime.join("node.exe"),
            runtime.join("node_modules").join("@wonderwhy-er").join("desktop-commander").join("dist").join("index.js"),
            self.resource_dir.join("proxy").join("MCPStdioProxy.mjs"),
        )
    }

    fn runtime_check(&self) -> Result<(), String> {
        let (tunnel, node, dc, transport) = self.runtime_files();
        let missing: Vec<_> = [tunnel, node, dc, transport].into_iter()
            .filter(|p| !p.is_file()).map(|p| p.display().to_string()).collect();
        if missing.is_empty() { Ok(()) }
        else { Err(format!("실행 리소스가 누락됐습니다({}개). 배포 리소스를 준비한 뒤 다시 빌드해 주세요.", missing.len())) }
    }

    // Health check is strictly bound to a local ephemeral loopback address.
    // A running process alone does not establish tunnel readiness.
    fn is_ready(&self) -> bool {
        let health_file = self.data_dir.join("logs").join("health.url");
        let Ok(url) = fs::read_to_string(health_file) else { return false; };
        let Some(host_port) = url.trim().strip_prefix("http://127.0.0.1:") else { return false; };
        let Ok(port) = host_port.split('/').next().unwrap_or("").parse::<u16>() else { return false; };
        if port == 0 { return false; }
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let Ok(mut socket) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else { return false; };
        let _ = socket.set_read_timeout(Some(Duration::from_millis(300)));
        let _ = socket.set_write_timeout(Some(Duration::from_millis(300)));
        if socket.write_all(b"GET /readyz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() { return false; }
        let mut response = [0; 64];
        matches!(socket.read(&mut response), Ok(size) if
            response[..size].starts_with(b"HTTP/1.1 200 ") || response[..size].starts_with(b"HTTP/1.0 200 "))
    }

    fn is_running(&self) -> Result<bool, String> {
        let mut child = self.process.lock().map_err(|e| e.to_string())?;
        if let Some(process) = child.as_mut() {
            match process.try_wait() {
                Ok(None) => Ok(true),
                Ok(Some(_)) => { *child = None; Ok(false) },
                Err(e) => Err(e.to_string()),
            }
        } else { Ok(false) }
    }

    fn stop(&self) -> Result<(), String> {
        let mut managed = self.process.lock().map_err(|e| e.to_string())?;
        let Some(child) = managed.as_mut() else { return Ok(()); };
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            *managed = None;
            return Ok(());
        }
        // Only the process tree this manager created may be stopped. Never
        // terminate all node.exe or tunnel-client.exe processes on the PC.
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let status = Command::new("taskkill.exe")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .stdout(Stdio::null()).stderr(Stdio::null())
                .status().map_err(|e| format!("관리 중인 터널을 종료하지 못했습니다: {e}"))?;
            if !status.success() && child.try_wait().map_err(|e| e.to_string())?.is_none() {
                return Err("관리 중인 터널 종료에 실패했습니다. 실행 상태를 확인한 뒤 다시 시도해 주세요.".into());
            }
        }
        #[cfg(not(target_os = "windows"))]
        { child.kill().map_err(|e| e.to_string())?; }
        child.wait().map_err(|e| e.to_string())?;
        *managed = None;
        Ok(())
    }

}

fn recent_connection_issue(path: &Path, baseline: u64) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let end = file.metadata().ok()?.len();
    // Read the newest bytes, not the oldest bytes since startup. Startup
    // logging can exceed 64 KiB before the first control-plane response.
    let start = baseline.min(end).max(end.saturating_sub(128 * 1024));
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    classify_connection_log(&String::from_utf8_lossy(&bytes)).map(str::to_owned)
}

fn classify_connection_log(log: &str) -> Option<&'static str> {
    if log.contains("tunnel_active_organization_required") {
        Some("조직 정보가 필요한 터널입니다. 연결 설정에서 OpenAI 조직 ID(org-...)를 입력해 주세요.")
    } else if log.contains("Unauthorized") || log.contains("status 401") {
        Some("터널 인증에 실패했습니다(401). 연결 설정의 API 키와 터널 ID를 확인해 주세요.")
    } else if log.contains("status 403") || log.contains("Forbidden") {
        Some("터널 접근이 거부됐습니다(403). 해당 터널에 대한 API 키 권한을 확인해 주세요.")
    } else if log.contains("OnStart hook failed") || log.contains("start stdio command") {
        Some("MCP 백엔드를 시작하지 못했습니다. 설치된 실행 리소스를 확인해 주세요.")
    } else { None }
}

fn secret_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, KEY_ACCOUNT).map_err(|e| e.to_string())
}

fn secret_is_set() -> bool {
    secret_entry().and_then(|e| e.get_password().map_err(|e| e.to_string()))
        .is_ok_and(|value| !value.is_empty())
}

fn validate_organization_id(value: &str) -> Result<(), String> {
    if !value.is_empty() && (!value.starts_with("org-") || value.len() > 128
        || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')) {
        return Err("조직 ID가 올바르지 않습니다. org-... 형식을 입력하거나 기본 계정을 사용하려면 비워 두세요.".into());
    }
    Ok(())
}

fn validate_tunnel_id(value: &str) -> Result<(), String> {
    if value.len() != 39 || !value.starts_with("tunnel_")
        || !value[7..].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
        return Err("터널 ID가 올바르지 않습니다. tunnel_ 뒤에 영문 소문자 또는 숫자 32자가 필요합니다.".into());
    }
    Ok(())
}

#[tauri::command]
fn get_status(manager: State<'_, CommanderState>) -> Result<Status, String> {
    let running = manager.is_running()?;
    let config = manager.config.lock().map_err(|e| e.to_string())?.clone();
    let runtime = manager.runtime_check();
    let connection_issue = manager.connection_issue();
    Ok(Status {
        running, ready: running && connection_issue.is_none() && manager.is_ready(),
        tunnel_id: config.tunnel_id,
        organization_id: config.organization_id,
        has_key: secret_is_set(),
        runtime_ready: runtime.is_ok(),
        runtime_message: runtime.err().unwrap_or_default(),
        connection_issue,
    })
}

#[tauri::command]
fn save_connection(manager: State<'_, CommanderState>, tunnel_id: String, organization_id: String, api_key: String) -> Result<(), String> {
    let id = tunnel_id.trim();
    validate_tunnel_id(id)?;
    validate_organization_id(organization_id.trim())?;
    if manager.is_running()? { return Err("인증 정보를 바꾸기 전에 터널 연결을 해제해 주세요.".into()); }
    if !api_key.is_empty() && (api_key.trim().is_empty() || (api_key.contains('\r') || api_key.contains('\n'))) {
        return Err("API 키는 빈칸이나 줄바꿈 없이 입력해 주세요.".into());
    }
    let mut config = manager.config.lock().map_err(|e| e.to_string())?;
    let mut proposed = config.clone();
    proposed.tunnel_id = id.to_string();
    proposed.organization_id = organization_id.trim().to_string();
    // Do not expose credential bytes in any settings or policy file.
    manager.save_config(&proposed)?;
    if !api_key.is_empty() {
        secret_entry()?.set_password(&api_key).map_err(|e| format!("Windows 자격 증명 관리자 오류: {e}"))?;
    }
    *config = proposed;
    *manager.log_start.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

fn quote_command(path: &Path) -> String {
    // The tunnel-client parses command strings with POSIX-like escaping, so
    // native Windows backslashes would be consumed before process creation.
    format!("\"{}\"", path.to_string_lossy().replace('\\', "/").replace('"', ""))
}

fn mcp_command(node: &Path, transport: &Path, dc: &Path) -> String {
    format!("{} {} -- {} {} --no-onboarding",
        quote_command(node), quote_command(transport),
        quote_command(node), quote_command(dc))
}

#[tauri::command]
fn connect_tunnel(manager: State<'_, CommanderState>) -> Result<(), String> {
    if manager.is_running()? { return Ok(()); }
    manager.runtime_check()?;
    let config = manager.config.lock().map_err(|e| e.to_string())?.clone();
    validate_tunnel_id(&config.tunnel_id)?;
    validate_organization_id(&config.organization_id)?;
    let api_key = secret_entry()?.get_password().map_err(|_| "저장된 API 키가 없습니다. 연결 설정을 열어 주세요.".to_string())?;
    if api_key.trim().is_empty() { return Err("저장된 API 키가 없습니다.".into()); }
    let (tunnel, node, dc, transport) = manager.runtime_files();
    let profile_dir = manager.data_dir.join("profiles");
    let logs = manager.data_dir.join("logs");
    let spool = manager.data_dir.join("spool");
    for directory in [&profile_dir, &logs, &spool] {
        fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    }
    manager.save_config(&config)?;
    // Never reuse a previous process's health file for this new connection.
    let _ = fs::remove_file(logs.join("health.url"));
    // Transport proxy owns MCP session replay and directly supervises DC.
    let mcp_command = mcp_command(&node, &transport, &dc);
    let mut profile = serde_json::json!({
        "admin_ui": { "open_browser": false },
        "config_version": 1,
        "control_plane": { "api_key": "env:CONTROL_PLANE_API_KEY", "base_url": "https://api.openai.com", "tunnel_id": config.tunnel_id },
        "health": { "listen_addr": "127.0.0.1:0", "url_file": logs.join("health.url").to_string_lossy() },
        "log": { "file": logs.join("tunnel.log").to_string_lossy(), "format": "json", "level": "info" },
        "mcp": { "commands": [{ "channel": "main", "command": mcp_command }] }
    });
    if !config.organization_id.is_empty() {
        profile["control_plane"]["organization_id"] = serde_json::Value::String(config.organization_id.clone());
    }
    fs::write(profile_dir.join("commander-manager.yaml"),
        serde_json::to_vec_pretty(&profile).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    // Keep backend exceptions locally; tunnel.log contains dispatcher events,
    // while the stdio proxy and its Node child report failures on stderr.
    let backend_log = fs::OpenOptions::new().create(true).append(true)
        .open(logs.join("backend.stderr.log")).map_err(|e| e.to_string())?;
    let mut child = Command::new(tunnel);
    // Always name the exact manager-owned profile. Supplying a directory alone
    // does not select a profile in tunnel-client.
    child.arg("run").arg("--profile-file").arg(profile_dir.join("commander-manager.yaml"))
        .env("CONTROL_PLANE_API_KEY", api_key)
        .env("DESKTOP_COMMANDER_DISABLE_TELEMETRY", "1")
        .env("MCP_STDIO_SEND_INITIALIZED_NOTIFICATION", "1")
        .env("MCP_BACKEND_RESTART_TRIGGER", manager.restart_trigger())
        .env("MCP_PROXY_SPOOL_DIR", spool)

        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(backend_log);
    #[cfg(target_os = "windows")]
    { use std::os::windows::process::CommandExt; child.creation_flags(0x08000000); }
    // Inspect only messages created by this connection attempt, never stale errors.
    let log_length = fs::metadata(manager.tunnel_log()).map(|m| m.len()).unwrap_or(0);
    *manager.log_start.lock().map_err(|e| e.to_string())? = Some(log_length);
    let process = child.spawn().map_err(|e| format!("터널 실행기를 시작하지 못했습니다: {e}"))?;
    *manager.process.lock().map_err(|e| e.to_string())? = Some(process);
    std::thread::sleep(Duration::from_millis(450));
    if !manager.is_running()? {
        return Err(manager.connection_issue().unwrap_or_else(|| "터널 실행기가 시작 중 종료됐습니다. 실행 리소스 설치 상태를 확인해 주세요.".into()));
    }
    Ok(())
}

#[tauri::command]
fn disconnect_tunnel(manager: State<'_, CommanderState>) -> Result<(), String> {
    manager.stop()?;
    *manager.log_start.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command]
fn restart_dc(manager: State<'_, CommanderState>) -> Result<(), String> {
    if !manager.is_running()? { return Err("터널이 실행 중이 아닙니다.".into()); }
    manager.signal_restart()
}

#[tauri::command]
fn exit_manager(app: AppHandle, manager: State<'_, CommanderState>) -> Result<(), String> {
    manager.stop()?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::quote_command;
    use std::path::Path;

    #[test]
    fn quotes_windows_paths_without_backslash_escaping() {
        assert_eq!(quote_command(Path::new(r"C:\Program Files\Node\node.exe")), "\"C:/Program Files/Node/node.exe\"");
    }

    #[test]
    fn starts_desktop_commander_directly_without_policy_layer() {
        let command = super::mcp_command(
            Path::new(r"C:\Program Files\Node\node.exe"),
            Path::new(r"C:\Manager\proxy\MCPStdioProxy.mjs"),
            Path::new(r"C:\Runtime\desktop-commander\index.js"),
        );
        assert_eq!(command,
            "\"C:/Program Files/Node/node.exe\" \"C:/Manager/proxy/MCPStdioProxy.mjs\" -- \"C:/Program Files/Node/node.exe\" \"C:/Runtime/desktop-commander/index.js\" --no-onboarding");
    }

    #[test]
    fn rejects_invalid_tunnel_id_before_launch() {
        assert!(super::validate_tunnel_id(&format!("tunnel_{}", "a".repeat(32))).is_ok());
        assert!(super::validate_tunnel_id("tunnel_invalid").is_err());
        assert!(super::validate_tunnel_id(&format!("tunnel_{}", "A".repeat(32))).is_err());
    }

    #[test]
    fn reports_only_safe_connection_diagnostics() {
        assert!(super::classify_connection_log("poll failed: 401 Unauthorized").unwrap().contains("인증"));
        assert!(super::classify_connection_log("OnStart hook failed: raw username path").unwrap().contains("MCP 백엔드"));
        assert!(super::classify_connection_log("request body: secret-example").is_none());
        assert!(super::classify_connection_log("401: tunnel_active_organization_required").unwrap().contains("조직 ID"));
    }

    #[test]
    fn permits_optional_organization_context() {
        assert!(super::validate_organization_id("").is_ok());
        assert!(super::validate_organization_id("org-example123").is_ok());
        assert!(super::validate_organization_id("wrong_id").is_err());
    }

    #[test]
    fn stores_only_connection_identifiers_and_rejects_unexpected_fields() {
        let serialized = serde_json::to_value(super::Settings::default()).unwrap();
        assert_eq!(serialized.as_object().unwrap().len(), 2);
        assert!(serialized.get("tunnel_id").is_some());
        assert!(serialized.get("organization_id").is_some());
        assert!(serialized.get("api_key").is_none());
        assert!(serde_json::from_str::<super::Settings>(
            r#"{"tunnel_id":"","organization_id":"","unexpected":true}"#
        ).is_err());
    }

    #[test]
    fn discovers_errors_after_large_utf8_startup_logs() {
        let file = std::env::temp_dir().join(format!("commander-startup-log-{}.txt", std::process::id()));
        let startup = "startup ☑ ".repeat(9000);
        std::fs::write(&file, format!("{startup}\n401: tunnel_active_organization_required\n")).unwrap();
        let issue = super::recent_connection_issue(&file, 0);
        let _ = std::fs::remove_file(&file);
        assert!(issue.unwrap().contains("조직 ID"));
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let directory = app.path().app_local_data_dir()?;
            // Debug smoke tests must never touch the installed Manager profile.
            #[cfg(debug_assertions)]
            let directory = std::env::var_os("COMMANDER_MANAGER_TEST_DATA_DIR")
                .map(PathBuf::from).unwrap_or(directory);
            fs::create_dir_all(&directory)?;
            let settings_path = directory.join("connection.json");
            let settings = if settings_path.is_file() {
                serde_json::from_slice::<Settings>(&fs::read(&settings_path)?)?
            } else { Settings::default() };
            let resources = app.path().resource_dir()?;
            let manager = CommanderState {
                config: Mutex::new(settings.clone()),
                process: Mutex::new(None),
                data_dir: directory,
                resource_dir: resources,
                log_start: Mutex::new(None),
            };
            manager.save_config(&settings)?;
            app.manage(manager);
            let open = MenuItem::with_id(app, "show", "연결 관리자 열기", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or_else(|| std::io::Error::other("Missing app icon"))?.clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => { if let Some(win) = app.get_webview_window("main") { let _ = win.show(); let _ = win.set_focus(); } },
                    "quit" => {
                        let state: State<'_, CommanderState> = app.state();
                        if let Err(error) = state.stop() {
                            eprintln!("Cannot quit manager: {error}");
                        } else { app.exit(0); }
                    },
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(win) = tray.app_handle().get_webview_window("main") { let _ = win.show(); let _ = win.set_focus(); }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "main" { let _ = window.hide(); }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_status, save_connection, connect_tunnel, disconnect_tunnel,
            restart_dc, exit_manager
        ])
        .build(tauri::generate_context!())
        .expect("Error running Desktop Commander Manager")
        .run(|_, _| {});
}
