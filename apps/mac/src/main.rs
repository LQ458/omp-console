mod automation;
mod deep_link;
use std::{fs, path::PathBuf, sync::{Arc, Mutex}, time::Duration};

#[cfg(any(target_os = "macos", test))]
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{redirect::Policy, Client};
#[cfg(target_os = "macos")]
use ring::rand::SystemRandom;
#[cfg(any(target_os = "macos", test))]
use ring::signature::Ed25519KeyPair;
#[cfg(target_os = "macos")]
use ring::signature::KeyPair;
#[cfg(target_os = "macos")]
use security_framework::passwords::{generic_password, set_generic_password, PasswordOptions};
use serde::{Deserialize, Serialize};
use tauri::{
	ipc::CapabilityBuilder,
	menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
	webview::{NewWindowResponse, PageLoadEvent},
	AppHandle, Manager, State, WebviewUrl, WebviewWindow, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;
#[cfg(target_os = "macos")]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use url::{Host, Url};

const DEFAULT_DAEMON_URL: &str = "http://127.0.0.1:7490/";
const DEFAULT_STATE_DIR: &str = "~/.omp-console";
const APP_SCHEME_URL: &str = "tauri://localhost/index.html";
#[cfg(target_os = "macos")]
/// Keychain item holding the PKCS#8 Ed25519 signing key; only omp console reads it (the daemon gets the public key only).
const MOVE_KEY_SERVICE: &str = "omp-console-move-signing-key";
#[cfg(target_os = "macos")]
const MOVE_KEY_ACCOUNT: &str = "omp-console-move-confirmation";
/// Public key file the daemon verifies confirmations with, next to `config.json`.
#[cfg(target_os = "macos")]
const MOVE_PUBLIC_KEY_FILE: &str = "move-public-key";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
struct AppConfig {
	daemon_url: String,
	state_dir: String,
	window: WindowBounds,
}

impl Default for AppConfig {
	fn default() -> Self {
		Self {
			daemon_url: DEFAULT_DAEMON_URL.to_string(),
			state_dir: DEFAULT_STATE_DIR.to_string(),
			window: WindowBounds::default(),
		}
	}
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
struct WindowBounds {
	x: Option<f64>,
	y: Option<f64>,
	width: f64,
	height: f64,
}

impl Default for WindowBounds {
	fn default() -> Self {
		Self {
			x: None,
			y: None,
			width: 1200.0,
			height: 820.0,
		}
	}
}

struct AppState {
	config_path: PathBuf,
	config: Mutex<AppConfig>,
	settings_window: Mutex<Option<WebviewWindow>>,
	#[cfg(target_os = "macos")]
	move_key_lock: Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectResult {
	url: String,
	reachable: bool,
	error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonSettings {
	daemon_url: String,
	state_dir: String,
}

fn validate_daemon_url(raw: &str) -> Result<Url, String> {
	let url = Url::parse(raw.trim()).map_err(|_| "Enter a valid URL.".to_string())?;
	if !url.username().is_empty() || url.password().is_some() {
		return Err("URLs with embedded credentials are not allowed.".to_string());
	}
	if url.query().is_some() || url.fragment().is_some() || url.path() != "/" {
		return Err("Use a daemon origin without a path, query, or fragment.".to_string());
	}

	let host = url.host().ok_or_else(|| "The URL must include a host.".to_string())?;
	let is_loopback = match host {
		Host::Ipv4(address) => address.is_loopback(),
		Host::Ipv6(address) => address.is_loopback(),
		Host::Domain(domain) => {
			let domain = domain.trim_end_matches('.').to_ascii_lowercase();
			domain == "localhost" || domain.ends_with(".localhost")
		},
	};

	match url.scheme() {
		"https" => Ok(url),
		"http" if is_loopback => Ok(url),
		"http" => Err("HTTP is allowed only for loopback hosts; use HTTPS for remote daemons.".to_string()),
		_ => Err("Use an HTTP or HTTPS URL.".to_string()),
	}
}

fn is_loopback_url(url: &Url) -> bool {
	url.host().is_some_and(|host| match host {
		Host::Ipv4(address) => address.is_loopback(),
		Host::Ipv6(address) => address.is_loopback(),
		Host::Domain(domain) => {
			let domain = domain.trim_end_matches('.').to_ascii_lowercase();
			domain == "localhost" || domain.ends_with(".localhost")
		},
	})
}

fn expand_state_dir(raw: &str) -> Result<PathBuf, String> {
	let raw = raw.trim();
	if raw.is_empty() {
		return Err("Enter a state directory.".to_string());
	}
	let path = if raw == "~" || raw.starts_with("~/") {
		let home = std::env::var_os("HOME").ok_or_else(|| "The home directory is unavailable.".to_string())?;
		if raw == "~" { PathBuf::from(home) } else { PathBuf::from(home).join(&raw[2..]) }
	} else {
		PathBuf::from(raw)
	};
	if !path.is_absolute() {
		return Err("Use an absolute state directory or a path under ~.".to_string());
	}
	Ok(path)
}

fn normalize_state_dir(raw: &str) -> Result<String, String> {
	expand_state_dir(raw)?;
	Ok(raw.trim().to_string())
}

fn valid_pairing_code(code: &str) -> bool {
	let Some((first, second)) = code.split_once('-') else {
		return false;
	};
	first.len() == 4
		&& second.len() == 4
		&& !second.contains('-')
		&& first.bytes().chain(second.bytes()).all(|byte| {
			matches!(byte, b'0'..=b'9' | b'A'..=b'H' | b'J'..=b'K' | b'M'..=b'N' | b'P'..=b'T' | b'V'..=b'Z')
		})
}

fn read_pairing_code_file(state_dir: &PathBuf) -> Result<Option<String>, String> {
	let path = state_dir.join("pairing-code");
	let metadata = match fs::symlink_metadata(&path) {
		Ok(metadata) => metadata,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
		Err(error) => return Err(error.to_string()),
	};
	if !metadata.file_type().is_file() {
		return Ok(None);
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		if metadata.permissions().mode() & 0o777 != 0o600 {
			return Ok(None);
		}
	}
	let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
	let code = contents.trim();
	if !valid_pairing_code(code) {
		return Ok(None);
	}
	Ok(Some(code.to_string()))
}

fn load_state(app: &AppHandle) -> Result<AppState, String> {
	let config_dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
	fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
	let config_path = config_dir.join("config.json");
	let mut config = match fs::read_to_string(&config_path) {
		Ok(contents) => serde_json::from_str::<AppConfig>(&contents).unwrap_or_default(),
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => AppConfig::default(),
		Err(error) => return Err(error.to_string()),
	};

	match validate_daemon_url(&config.daemon_url) {
		Ok(url) => config.daemon_url = url.to_string(),
		Err(_) => config = AppConfig::default(),
	}
	if expand_state_dir(&config.state_dir).is_err() {
		config = AppConfig::default();
	}

	let override_url = match std::env::var_os("OMP_CONSOLE_DAEMON_URL_FILE") {
		Some(path) => {
			let path = PathBuf::from(path);
			match fs::read_to_string(&path) {
				Ok(raw) => {
					fs::remove_file(path).map_err(|error| error.to_string())?;
					Some(validate_daemon_url(&raw)?.to_string())
				}
				Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
				Err(error) => return Err(error.to_string()),
			}
		}
		None => None,
	};
	let state = AppState {
		config_path,
		config: Mutex::new(config),
		settings_window: Mutex::new(None),
		#[cfg(target_os = "macos")]
		move_key_lock: Mutex::new(()),
	};
	if let Some(url) = override_url {
		state
			.config
			.lock()
			.map_err(|_| "App configuration lock is poisoned.".to_string())?
			.daemon_url = url;
	} else {
		persist_config(&state)?;
	}
	Ok(state)
}

fn persist_config(state: &AppState) -> Result<(), String> {
	let config = state
		.config
		.lock()
		.map_err(|_| "App configuration lock is poisoned.".to_string())?;
	let bytes = serde_json::to_vec_pretty(&*config).map_err(|error| error.to_string())?;
	let temporary = state.config_path.with_extension("json.tmp");
	fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
	fs::rename(&temporary, &state.config_path).map_err(|error| error.to_string())
}

fn update_window_bounds(window: &WebviewWindow, state: &AppState) {
	let Ok(scale) = window.scale_factor() else {
		return;
	};
	let position = window.outer_position().ok().map(|position| position.to_logical::<f64>(scale));
	let size = window.inner_size().ok().map(|size| size.to_logical::<f64>(scale));
	let Ok(mut config) = state.config.lock() else {
		return;
	};
	if let Some(position) = position {
		config.window.x = Some(position.x);
		config.window.y = Some(position.y);
	}
	if let Some(size) = size {
		config.window.width = size.width.max(760.0);
		config.window.height = size.height.max(500.0);
	}
	let _ = persist_locked(&state.config_path, &config);
}

fn persist_locked(path: &PathBuf, config: &AppConfig) -> Result<(), String> {
	let bytes = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
	let temporary = path.with_extension("json.tmp");
	fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
	fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn daemon_url(state: &AppState) -> Result<Url, String> {
	let config = state
		.config
		.lock()
		.map_err(|_| "App configuration lock is poisoned.".to_string())?;
	validate_daemon_url(&config.daemon_url)
}

#[tauri::command]
async fn connect_daemon(window: WebviewWindow, state: State<'_, AppState>) -> Result<ConnectResult, String> {
	if window.label() != "main" {
		return Err("Connection checks are available only in the main window.".to_string());
	}
	let url = daemon_url(&state)?;
	let health_url = url.join("api/health").map_err(|error| error.to_string())?;
	let client = Client::builder()
		.timeout(Duration::from_secs(4))
		.redirect(Policy::none())
		.build()
		.map_err(|error| error.to_string())?;

	let result = match client.get(health_url).send().await {
		Ok(response) if response.status().is_success() => {
			window.navigate(url.clone()).map_err(|error| error.to_string())?;
			ConnectResult {
				url: url.to_string(),
				reachable: true,
				error: None,
			}
		}
		Ok(response) => ConnectResult {
			url: url.to_string(),
			reachable: false,
			error: Some(format!("health check returned HTTP {}", response.status())),
		},
		Err(error) => ConnectResult {
			url: url.to_string(),
			reachable: false,
			error: Some(if error.is_timeout() {
				"request timed out".to_string()
			} else {
				"connection failed".to_string()
			}),
		},
	};
	Ok(result)
}

#[tauri::command]
fn get_daemon_settings(window: WebviewWindow, state: State<'_, AppState>) -> Result<DaemonSettings, String> {
	if window.label() != "settings" {
		return Err("Daemon settings are available only in the settings window.".to_string());
	}
	let config = state
		.config
		.lock()
		.map_err(|_| "App configuration lock is poisoned.".to_string())?;
	Ok(DaemonSettings {
		daemon_url: config.daemon_url.clone(),
		state_dir: config.state_dir.clone(),
	})
}

#[tauri::command]
fn save_daemon_settings(
	app: AppHandle,
	window: WebviewWindow,
	state: State<'_, AppState>,
	url: String,
	state_dir: String,
) -> Result<(), String> {
	if window.label() != "settings" {
		return Err("Daemon settings are available only in the settings window.".to_string());
	}
	let url = validate_daemon_url(&url)?.to_string();
	let state_dir = normalize_state_dir(&state_dir)?;
	{
		let mut config = state
			.config
			.lock()
			.map_err(|_| "App configuration lock is poisoned.".to_string())?;
		config.daemon_url = url;
		config.state_dir = state_dir;
		persist_locked(&state.config_path, &config)?;
	}
	app.restart()
}

#[tauri::command]
fn read_pairing_code(window: WebviewWindow, state: State<'_, AppState>) -> Result<Option<String>, String> {
	if window.label() != "main" {
		return Err("Pairing code access is available only in the main window.".to_string());
	}
	let configured_url = daemon_url(&state)?;
	let current_origin = window.url().map_err(|_| "Could not verify the current page origin.".to_string())?.origin();
	if current_origin != configured_url.origin() {
		return Err("Pairing code access is available only to the configured daemon.".to_string());
	}
	if !is_loopback_url(&configured_url) {
		return Ok(None);
	}
	let state_dir = state
		.config
		.lock()
		.map_err(|_| "App configuration lock is poisoned.".to_string())?
		.state_dir
		.clone();
	read_pairing_code_file(&expand_state_dir(&state_dir)?)
}

#[cfg(target_os = "macos")]
fn valid_move_component(value: &str) -> bool {
	!value.is_empty()
		&& value.len() <= 128
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(target_os = "macos")]
fn keychain_move_key(state: &AppState) -> Result<Ed25519KeyPair, String> {
	let _guard = state
		.move_key_lock
		.lock()
		.map_err(|_| "Move-key lock is poisoned.".to_string())?;
	let pkcs8 = match generic_password(PasswordOptions::new_generic_password(MOVE_KEY_SERVICE, MOVE_KEY_ACCOUNT)) {
		Ok(stored) => URL_SAFE_NO_PAD
			.decode(&stored)
			.map_err(|_| "Stored move key is not valid base64url.".to_string())?,
		Err(error) if error.code() == -25300 => {
			let generated = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
				.map_err(|_| "Could not generate a move key.".to_string())?;
			set_generic_password(MOVE_KEY_SERVICE, MOVE_KEY_ACCOUNT, URL_SAFE_NO_PAD.encode(generated.as_ref()).as_bytes())
				.map_err(|error| format!("Could not save the move key to Keychain: {error}"))?;
			generated.as_ref().to_vec()
		}
		Err(error) => return Err(format!("Could not read the move key from Keychain: {error}")),
	};
	let pair = Ed25519KeyPair::from_pkcs8(&pkcs8).map_err(|_| "Stored move key is not an Ed25519 key.".to_string())?;
	write_move_public_key(state, &pair)?;
	Ok(pair)
}

/// The daemon reads this to verify confirmations; rewritten on every use so a deleted or stale file heals.
#[cfg(target_os = "macos")]
fn write_move_public_key(state: &AppState, pair: &Ed25519KeyPair) -> Result<(), String> {
	let dir = state
		.config_path
		.parent()
		.ok_or_else(|| "App config directory is unknown.".to_string())?;
	fs::create_dir_all(dir).map_err(|error| error.to_string())?;
	fs::write(dir.join(MOVE_PUBLIC_KEY_FILE), URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()))
		.map_err(|error| format!("Could not write the move public key: {error}"))
}

#[cfg(any(target_os = "macos", test))]
fn move_signature(pair: &Ed25519KeyPair, challenge: &str) -> String {
	URL_SAFE_NO_PAD.encode(pair.sign(challenge.as_bytes()).as_ref())
}

#[cfg(any(target_os = "macos", test))]
/// What the daemon says about one move (`GET /api/moves/:id`); the dialog is built from this, never from page text.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveDetail {
	#[cfg(target_os = "macos")]
	id: String,
	#[cfg(target_os = "macos")]
	state: String,
	source_root: String,
	destination: String,
	files: u64,
	bytes: u64,
	#[serde(default)]
	excluded: Vec<serde_json::Value>,
	#[cfg(target_os = "macos")]
	nonce: Option<String>,
}

/// A path shown in the native dialog: control characters, Unicode line/paragraph separators and invisible format
/// characters (bidi overrides, zero-width) are escaped, so a folder name cannot fake extra lines of the confirmation or
/// reorder what it shows.
#[cfg(any(target_os = "macos", test))]
fn dialog_path(path: &str) -> String {
	let hidden = |c: char| {
		c.is_control()
			|| matches!(c, '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{2028}' | '\u{2029}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
	};
	path.chars().flat_map(|c| if hidden(c) { c.escape_unicode().collect::<Vec<_>>() } else { vec![c] }).collect()
}

#[cfg(any(target_os = "macos", test))]
fn move_dialog_text(detail: &MoveDetail) -> String {
	let size = if detail.bytes >= 1024 * 1024 {
		format!("{:.1} MB", detail.bytes as f64 / (1024.0 * 1024.0))
	} else {
		format!("{:.1} KB", detail.bytes as f64 / 1024.0)
	};
	format!(
		"Copy {} files ({size}) into a new project.\n\nFrom: {}\nTo: {}\n\n{} item(s) are left out (dependencies, secrets, special files). The original folder stays where it is; a new session starts in the copy.",
		detail.files,
		dialog_path(&detail.source_root),
		dialog_path(&detail.destination),
		detail.excluded.len(),
	)
}

#[cfg(target_os = "macos")]
async fn fetch_move_detail(state: &AppState, move_id: &str) -> Result<MoveDetail, String> {
	let url = daemon_url(state)?
		.join(&format!("api/moves/{move_id}"))
		.map_err(|error| error.to_string())?;
	let client = Client::builder()
		.timeout(Duration::from_secs(5))
		.redirect(Policy::none())
		.build()
		.map_err(|error| error.to_string())?;
	let response = client
		.get(url)
		.send()
		.await
		.map_err(|_| "Could not reach the daemon for the move details.".to_string())?;
	if !response.status().is_success() {
		return Err(format!("The daemon returned HTTP {} for this move.", response.status()));
	}
	let body = response
		.text()
		.await
		.map_err(|_| "Could not read the daemon's move details.".to_string())?;
	serde_json::from_str::<MoveDetail>(&body).map_err(|_| "The daemon's move details are malformed.".to_string())
}

/// Async so it runs off the main thread: the dialog's callback needs the main run loop (a blocking wait there deadlocks).
#[cfg(target_os = "macos")]
#[tauri::command]
async fn confirm_move(window: WebviewWindow, state: State<'_, AppState>, move_id: String, nonce: String) -> Result<String, String> {
	if window.label() != "main" {
		return Err("Move confirmation is available only in the main window.".to_string());
	}
	if !valid_move_component(&move_id) || !valid_move_component(&nonce) {
		return Err("Move confirmation details are invalid.".to_string());
	}
	let expected_origin = daemon_url(&state)?.origin();
	let current_origin = window.url().map_err(|_| "Could not verify the current page origin.".to_string())?.origin();
	if current_origin != expected_origin {
		return Err("Move confirmation is available only to the configured daemon.".to_string());
	}
	let detail = fetch_move_detail(&state, &move_id).await?;
	if detail.id != move_id || detail.state != "prepared" || detail.nonce.as_deref() != Some(nonce.as_str()) {
		return Err("This move is no longer waiting for confirmation.".to_string());
	}
	let (sender, receiver) = std::sync::mpsc::channel();
	window
		.dialog()
		.message(move_dialog_text(&detail))
		.title("Confirm safe move")
		.kind(MessageDialogKind::Warning)
		.buttons(MessageDialogButtons::OkCancelCustom("Cancel".to_string(), "Move".to_string()))
		.show_with_result(move |result| {
			let _ = sender.send(result);
		});
	let result = tauri::async_runtime::spawn_blocking(move || receiver.recv())
		.await
		.map_err(|_| "The confirmation dialog failed.".to_string())?
		.map_err(|_| "The confirmation dialog closed without an answer.".to_string())?;
	if result != MessageDialogResult::Custom("Move".to_string()) {
		return Err("Move cancelled.".to_string());
	}
	let pair = keychain_move_key(&state)?;
	Ok(move_signature(&pair, &format!("{move_id}.{nonce}")))
}
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn confirm_move(window: WebviewWindow, state: State<'_, AppState>, move_id: String, nonce: String) -> Result<String, String> {
	let _ = (window, state, move_id, nonce);
	Err(move_confirmation_error().to_string())
}

#[cfg(not(target_os = "macos"))]
fn move_confirmation_error() -> &'static str {
	"Moving projects between computers needs macOS."
}

/** Plain text, one line, bounded: notification text comes from session titles the daemon reports. */
fn notification_text(value: &str, max: usize) -> String {
	let flat: String = value.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
	let trimmed = flat.trim();
	if trimmed.chars().count() <= max {
		trimmed.to_string()
	} else {
		format!("{}…", trimmed.chars().take(max - 1).collect::<String>())
	}
}

/// Returns a serialized eval result only to the opted-in automation client on
/// the configured daemon origin.
#[tauri::command(rename_all = "camelCase")]
fn automation_eval_result(
	window: WebviewWindow,
	state: State<'_, automation::AutomationState>,
	request_id: String,
	result: serde_json::Value,
) -> Result<(), String> {
	automation::accept_eval_result(&window, state.inner(), request_id, result)
}

/// Native macOS notification for "turn finished" / "needs your answer" while omp console is not in front (the WKWebView has
/// no Web Push). Only the main window on the configured daemon origin may call it.
#[tauri::command]
fn native_notify(window: WebviewWindow, state: State<'_, AppState>, title: String, body: String) -> Result<(), String> {
	if window.label() != "main" {
		return Err("Notifications are available only in the main window.".to_string());
	}
	let expected_origin = daemon_url(&state)?.origin();
	let current_origin = window.url().map_err(|_| "Could not verify the current page origin.".to_string())?.origin();
	if current_origin != expected_origin {
		return Err("Notifications are available only to the configured daemon.".to_string());
	}
	window
		.app_handle()
		.notification()
		.builder()
		.title(notification_text(&title, 80))
		.body(notification_text(&body, 200))
		.show()
		.map_err(|error| format!("Could not show the notification: {error}"))
}

#[cfg(target_os = "macos")]
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
	let about = PredefinedMenuItem::about(app, Some("About omp console"), None)?;
	let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("Cmd+,"))?;
	let about_separator = PredefinedMenuItem::separator(app)?;
	let settings_separator = PredefinedMenuItem::separator(app)?;
	let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("Cmd+Q"))?;
	let app_menu = Submenu::with_items(
		app,
		"omp console",
		true,
		&[&about, &about_separator, &settings, &settings_separator, &quit],
	)?;

	let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("Cmd+R"))?;
	let daemon_url = MenuItem::with_id(app, "daemon-url", "Daemon URL…", true, None::<&str>)?;
	let open_browser = MenuItem::with_id(app, "open-browser", "Open in Browser", true, None::<&str>)?;
	let close_window = MenuItem::with_id(app, "hide-window", "Close Window", true, Some("Cmd+W"))?;
	let file_menu = Submenu::with_items(
		app,
		"File",
		true,
		&[&reload, &daemon_url, &open_browser, &close_window],
	)?;

	let undo = PredefinedMenuItem::undo(app, None)?;
	let redo = PredefinedMenuItem::redo(app, None)?;
	let edit_separator = PredefinedMenuItem::separator(app)?;
	let cut = PredefinedMenuItem::cut(app, None)?;
	let copy = PredefinedMenuItem::copy(app, None)?;
	let paste = PredefinedMenuItem::paste(app, None)?;
	let select_all = PredefinedMenuItem::select_all(app, None)?;
	let edit_menu = Submenu::with_items(
		app,
		"Edit",
		true,
		&[&undo, &redo, &edit_separator, &cut, &copy, &paste, &select_all],
	)?;

	let appearance_system = MenuItem::with_id(app, "appearance-system", "System", true, None::<&str>)?;
	let appearance_light = MenuItem::with_id(app, "appearance-light", "Light", true, None::<&str>)?;
	let appearance_dark = MenuItem::with_id(app, "appearance-dark", "Dark", true, None::<&str>)?;
	let appearance_menu = Submenu::with_items(
		app,
		"Appearance",
		true,
		&[&appearance_system, &appearance_light, &appearance_dark],
	)?;
	let motion_off = MenuItem::with_id(app, "motion-off", "Off", true, None::<&str>)?;
	let motion_calm = MenuItem::with_id(app, "motion-calm", "Calm", true, None::<&str>)?;
	let motion_lively = MenuItem::with_id(app, "motion-lively", "Lively", true, None::<&str>)?;
	let motion_menu = Submenu::with_items(app, "Motion", true, &[&motion_off, &motion_calm, &motion_lively])?;
	let view_separator = PredefinedMenuItem::separator(app)?;
	let toggle_sidebar = MenuItem::with_id(app, "toggle-sidebar", "Toggle Sidebar", true, None::<&str>)?;
	let view_menu = Submenu::with_items(app, "View", true, &[&appearance_menu, &motion_menu, &view_separator, &toggle_sidebar])?;

	Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu])
}
#[cfg(not(target_os = "macos"))]
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
	let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("Ctrl+,"))?;
	let daemon_url = MenuItem::with_id(app, "daemon-url", "Daemon URL…", true, None::<&str>)?;
	let open_browser = MenuItem::with_id(app, "open-browser", "Open in Browser", true, None::<&str>)?;
	let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("Ctrl+R"))?;
	let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("Ctrl+Q"))?;
	let file_separator = PredefinedMenuItem::separator(app)?;
	let file_menu = Submenu::with_items(
		app,
		"File",
		true,
		&[&settings, &daemon_url, &reload, &open_browser, &file_separator, &quit],
	)?;

	let undo = PredefinedMenuItem::undo(app, None)?;
	let redo = PredefinedMenuItem::redo(app, None)?;
	let edit_separator = PredefinedMenuItem::separator(app)?;
	let cut = PredefinedMenuItem::cut(app, None)?;
	let copy = PredefinedMenuItem::copy(app, None)?;
	let paste = PredefinedMenuItem::paste(app, None)?;
	let select_all = PredefinedMenuItem::select_all(app, None)?;
	let edit_menu = Submenu::with_items(
		app,
		"Edit",
		true,
		&[&undo, &redo, &edit_separator, &cut, &copy, &paste, &select_all],
	)?;

	let appearance_system = MenuItem::with_id(app, "appearance-system", "System", true, None::<&str>)?;
	let appearance_light = MenuItem::with_id(app, "appearance-light", "Light", true, None::<&str>)?;
	let appearance_dark = MenuItem::with_id(app, "appearance-dark", "Dark", true, None::<&str>)?;
	let appearance_menu = Submenu::with_items(
		app,
		"Appearance",
		true,
		&[&appearance_system, &appearance_light, &appearance_dark],
	)?;
	let motion_off = MenuItem::with_id(app, "motion-off", "Off", true, None::<&str>)?;
	let motion_calm = MenuItem::with_id(app, "motion-calm", "Calm", true, None::<&str>)?;
	let motion_lively = MenuItem::with_id(app, "motion-lively", "Lively", true, None::<&str>)?;
	let motion_menu = Submenu::with_items(app, "Motion", true, &[&motion_off, &motion_calm, &motion_lively])?;
	let view_separator = PredefinedMenuItem::separator(app)?;
	let toggle_sidebar = MenuItem::with_id(app, "toggle-sidebar", "Toggle Sidebar", true, None::<&str>)?;
	let view_menu = Submenu::with_items(app, "View", true, &[&appearance_menu, &motion_menu, &view_separator, &toggle_sidebar])?;

	Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu])
}

#[cfg(target_os = "linux")]
fn is_wayland_session() -> bool {
	std::env::var_os("WAYLAND_DISPLAY").is_some()
		|| std::env::var("XDG_SESSION_TYPE").is_ok_and(|session| session.eq_ignore_ascii_case("wayland"))
}

#[cfg(not(target_os = "linux"))]
fn is_wayland_session() -> bool {
	false
}


fn show_settings(app: &AppHandle) -> tauri::Result<()> {
	let state = app.state::<AppState>();
	let mut stored = state
		.settings_window
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner());
	if let Some(window) = stored.as_ref() {
		window.show()?;
		window.set_focus()?;
		return Ok(());
	}
	let window = WebviewWindow::builder(app, "settings", WebviewUrl::App("settings.html".into()))
		.title("Daemon URL")
		.inner_size(500.0, 420.0)
		.min_inner_size(440.0, 380.0)
		.resizable(false)
		.center()
		.build()?;
	let app_handle = app.clone();
	window.on_window_event(move |event| {
		if matches!(event, WindowEvent::Destroyed) {
			let state = app_handle.state::<AppState>();
			state
				.settings_window
				.lock()
				.unwrap_or_else(|poisoned| poisoned.into_inner())
				.take();
		}
	});
	window.set_focus()?;
	*stored = Some(window);
	Ok(())
}

fn reload_main(app: &AppHandle) {
	if let Some(window) = app.get_webview_window("main") {
		let _ = window.navigate(APP_SCHEME_URL.parse().expect("constant app URL is valid"));
		let _ = window.show();
		let _ = window.set_focus();
	}
}
fn dispatch_native_menu_action(app: &AppHandle, action: serde_json::Value) {
	let Some(window) = app.get_webview_window("main") else {
		return;
	};
	let Ok(detail) = serde_json::to_string(&action) else {
		return;
	};
	let script = format!("window.dispatchEvent(new CustomEvent('omp-console:native-menu-action', {{ detail: {detail} }}));");
	let _ = window.eval(&script);
}

fn handle_menu_event(app: &AppHandle, id: &str) {
	match id {
		"hide-window" => {
			if let Some(window) = app.get_webview_window("main") {
				let _ = window.hide();
			}
		}
		"reload" => reload_main(app),
		"daemon-url" => {
			let _ = show_settings(app);
		}
		"open-browser" => {
			if let Ok(url) = daemon_url(&app.state::<AppState>()) {
				let _ = open::that(url.as_str());
			}
		}
		"settings" => dispatch_native_menu_action(app, serde_json::json!({ "type": "open-settings" })),
		"appearance-system" => dispatch_native_menu_action(app, serde_json::json!({ "type": "appearance", "preference": "system" })),
		"appearance-light" => dispatch_native_menu_action(app, serde_json::json!({ "type": "appearance", "preference": "light" })),
		"appearance-dark" => dispatch_native_menu_action(app, serde_json::json!({ "type": "appearance", "preference": "dark" })),
		"motion-off" => dispatch_native_menu_action(app, serde_json::json!({ "type": "motion", "level": "off" })),
		"motion-calm" => dispatch_native_menu_action(app, serde_json::json!({ "type": "motion", "level": "calm" })),
		"motion-lively" => dispatch_native_menu_action(app, serde_json::json!({ "type": "motion", "level": "lively" })),
		"toggle-sidebar" => dispatch_native_menu_action(app, serde_json::json!({ "type": "toggle-sidebar" })),
		"quit" => app.exit(0),
		_ => {}
	}
}

fn allow_navigation(app: &AppHandle, url: &Url) -> bool {
	if url.scheme() == "tauri" && url.host_str() == Some("localhost") {
		return true;
	}
	if tauri::is_dev()
		&& url.scheme() == "http"
		&& url.host_str() == Some("127.0.0.1")
		&& url.port() == Some(1420)
	{
		return true;
	}
	let allowed_origin = daemon_url(&app.state::<AppState>()).map(|configured| configured.origin());
	if allowed_origin.is_ok_and(|origin| url.origin() == origin) {
		return true;
	}
	if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
		let _ = open::that(url.as_str());
	}
	false
}

fn persist_window(window: &WebviewWindow, app: &AppHandle) {
	if window.label() != "main" {
		return;
	}
	update_window_bounds(window, &app.state::<AppState>());
}

fn toggle_main(app: &AppHandle) {
	if let Some(window) = app.get_webview_window("main") {
		if window.is_visible().unwrap_or(false) {
			let _ = window.hide();
		} else {
			let _ = window.show();
			let _ = window.set_focus();
		}
	}
}

#[derive(Default)]
struct DeepLinkWindowState {
	page_ready: bool,
	pending_hash: Option<String>,
}

fn set_deep_link_hash(window: &WebviewWindow, hash: &str) {
	let Ok(hash_json) = serde_json::to_string(hash) else {
		return;
	};
	let _ = window.eval(&format!("window.location.hash = {hash_json};"));
}

fn dispatch_deep_link(app: &AppHandle, url: &Url, delivery: &Mutex<DeepLinkWindowState>) {
	let Some(link) = deep_link::parse(url.as_str()) else {
		return;
	};
	let hash = link.hash_fragment();
	let window = app.get_webview_window("main");
	if let Some(window) = window.as_ref() {
		let _ = window.show();
		let _ = window.set_focus();
	}
	let mut delivery = delivery.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
	if delivery.page_ready {
		if let Some(window) = window.as_ref() {
			set_deep_link_hash(window, &hash);
			return;
		}
	}
	delivery.pending_hash = Some(hash);
}

fn flush_pending_deep_link(app: &AppHandle, delivery: &mut DeepLinkWindowState) {
	if !delivery.page_ready {
		return;
	}
	let Some(hash) = delivery.pending_hash.take() else {
		return;
	};
	if let Some(window) = app.get_webview_window("main") {
		set_deep_link_hash(&window, &hash);
	} else {
		delivery.pending_hash = Some(hash);
	}
}

fn main() {
	let is_wayland = is_wayland_session();
	if is_wayland {
		eprintln!("omp console global shortcut disabled: Wayland does not allow global shortcuts");
	}
	let mut builder = tauri::Builder::default();
	if !is_wayland {
		let shortcut_name = if cfg!(target_os = "macos") { "Command+Shift+Space" } else { "Ctrl+Shift+Space" };
		let shortcut = ShortcutBuilder::new()
			.with_shortcut(shortcut_name)
			.expect("global shortcut is valid")
			.with_handler(|app, _shortcut, event| {
				if event.state == ShortcutState::Pressed {
					toggle_main(app);
				}
			})
			.build();
		builder = builder.plugin(shortcut);
	}
	builder
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_notification::init())
		.plugin(tauri_plugin_deep_link::init())
		.invoke_handler(tauri::generate_handler![
			connect_daemon,
			get_daemon_settings,
			save_daemon_settings,
			read_pairing_code,
			confirm_move,
			native_notify,
			automation_eval_result
		])
		.setup(move |app| {
			if is_wayland {
				if let Err(error) = app
					.notification()
					.builder()
					.title("Global shortcut unavailable")
					.body("Wayland does not allow apps to register global shortcuts. Quit and reopen omp console from the applications menu.")
					.show()
				{
					eprintln!("Could not show the Wayland shortcut notice: {error}");
				}
			}
			let automation_dir = automation::directory_from_env().map_err(std::io::Error::other)?;
			let automation_enabled = automation_dir.is_some();
			if let Some(directory) = automation_dir.as_deref() {
				automation::prepare_directory(directory).map_err(std::io::Error::other)?;
				eprintln!("omp console automation enabled");
			}
			let state = load_state(app.handle()).map_err(std::io::Error::other)?;
			let configured_url = daemon_url(&state).map_err(std::io::Error::other)?;
			let automation_state = automation::AutomationState::new(
				automation_enabled,
				configured_url.origin().ascii_serialization(),
			);
			let mut capability = CapabilityBuilder::new("configured-daemon-origin")
				.window("main")
				.local(false)
				.remote(configured_url.origin().ascii_serialization())
				.permission("allow-confirm-move")
				.permission("allow-native-notify")
				.permission("allow-read-pairing-code");
			if automation_enabled {
				capability = capability.permission("allow-automation-eval-result");
			}
			app.add_capability(capability)?;
			let bounds = state
				.config
				.lock()
				.map_err(|_| std::io::Error::other("App configuration lock is poisoned"))?
				.window
				.clone();
			app.manage(state);
			app.manage(automation_state);
			let delivery = Arc::new(Mutex::new(DeepLinkWindowState::default()));
			let deep_link_app = app.handle().clone();
			let listener_delivery = Arc::clone(&delivery);
			app.deep_link().on_open_url(move |event| {
				for url in event.urls() {
					dispatch_deep_link(&deep_link_app, &url, &listener_delivery);
				}
			});
			if let Ok(Some(urls)) = app.deep_link().get_current() {
				for url in urls {
					dispatch_deep_link(app.handle(), &url, &delivery);
				}
			}

			let menu = build_menu(app.handle())?;
			app.set_menu(menu.clone())?;
			let app_handle = app.handle().clone();
			app.on_menu_event(move |_app, event| handle_menu_event(&app_handle, event.id().as_ref()));

			let mut builder = WebviewWindow::builder(
				app,
				"main",
				WebviewUrl::App("index.html".into()),
			)
			.title("omp console")
			.inner_size(bounds.width, bounds.height)
			// Keep Finder drops in HTML5 DataTransfer; native Tauri drop events suppress the composer's web drop handler.
			.disable_drag_drop_handler()
			.menu(menu)
			.on_page_load({
				let app_handle = app.handle().clone();
				let delivery = Arc::clone(&delivery);
				let daemon_origin = configured_url.origin();
				move |_webview, payload| {
					let mut delivery = delivery.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
					match payload.event() {
						PageLoadEvent::Started => delivery.page_ready = false,
						PageLoadEvent::Finished => {
							delivery.page_ready = payload.url().origin() == daemon_origin;
							flush_pending_deep_link(&app_handle, &mut delivery);
						}
					}
				}
			})
			.on_navigation({
				let app_handle = app.handle().clone();
				move |url| allow_navigation(&app_handle, url)
			})
			.on_new_window(|url, _features| {
				if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
					let _ = open::that(url.as_str());
				}
				NewWindowResponse::Deny
			});
			if !automation_enabled {
				builder = builder.min_inner_size(760.0, 500.0);
			}
			if let (Some(x), Some(y)) = (bounds.x, bounds.y) {
				builder = builder.position(x, y);
			}
			let window = builder.build()?;
			if let Some(directory) = automation_dir {
				automation::start(app.handle().clone(), directory, configured_url)
					.map_err(std::io::Error::other)?;
			}
			if delivery.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).pending_hash.is_some() {
				let _ = window.show();
				let _ = window.set_focus();
			}
			let app_handle = app.handle().clone();
			let tracked_window = window.clone();
			let persist_bounds = !automation_enabled;
			window.on_window_event(move |event| match event {
				WindowEvent::CloseRequested { api, .. } => {
					#[cfg(target_os = "macos")]
					{
						api.prevent_close();
						let _ = tracked_window.hide();
					}
					#[cfg(not(target_os = "macos"))]
					let _ = api;
				}
				WindowEvent::Moved(_) | WindowEvent::Resized(_) if persist_bounds => {
					persist_window(&tracked_window, &app_handle);
				}
				_ => {}
			});
			Ok(())
		})
		.build(tauri::generate_context!())
		.expect("failed to build omp console")
		// macOS Dock reopen restores the window hidden by Cmd+W.
		.run(|app, event| {
			#[cfg(target_os = "macos")]
			if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = event {
				if let Some(window) = app.get_webview_window("main") {
					let _ = window.show();
					let _ = window.set_focus();
				}
			}
			#[cfg(not(target_os = "macos"))]
			let _ = (app, event);
		});
}

#[cfg(test)]
mod tests {
	use super::{move_dialog_text, move_signature, validate_daemon_url, MoveDetail};
	use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
	use ring::{
		rand::SystemRandom,
		signature::{self, Ed25519KeyPair, KeyPair},
	};

	#[cfg(not(target_os = "macos"))]
	#[test]
	fn project_moves_explain_the_platform_requirement() {
		assert_eq!(
			super::move_confirmation_error(),
			"Moving projects between computers needs macOS."
		);
	}

	#[test]
	fn daemon_urls_require_https_except_for_loopback() {
		assert!(validate_daemon_url("http://127.0.0.1:7491").is_ok());
		assert!(validate_daemon_url("http://[::1]:7491").is_ok());
		assert!(validate_daemon_url("https://omp-console.example.ts.net").is_ok());
		assert!(validate_daemon_url("http://omp-console.example.ts.net").is_err());
	}

	#[test]
	fn daemon_urls_reject_credentials_and_non_origin_paths() {
		assert!(validate_daemon_url("https://user:pass@omp-console.example.ts.net").is_err());
		assert!(validate_daemon_url("https://omp-console.example.ts.net/path").is_err());
		assert!(validate_daemon_url("https://omp-console.example.ts.net/?token=x").is_err());
		assert!(validate_daemon_url("http://localhost.evil.example").is_err());
	}

	#[test]
	fn move_signature_verifies_with_the_public_key_only() {
		let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
		let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
		let token = move_signature(&pair, "move-1.nonce-1");
		let raw = URL_SAFE_NO_PAD.decode(token).unwrap();
		let public = signature::UnparsedPublicKey::new(&signature::ED25519, pair.public_key().as_ref());
		assert!(public.verify(b"move-1.nonce-1", &raw).is_ok());
		assert!(public.verify(b"move-1.other-nonce", &raw).is_err());
	}

	#[test]
	fn dialog_text_comes_from_daemon_facts() {
		let detail: MoveDetail = serde_json::from_str(
			r#"{"id":"m","state":"prepared","sourceRoot":"/kb/tools/owl","destination":"/gh/owl","files":3,"bytes":2048,"excluded":[{"path":".env"}],"nonce":"n"}"#,
		)
		.unwrap();
		let text = move_dialog_text(&detail);
		assert!(text.contains("Copy 3 files (2.0 KB)"));
		assert!(text.contains("From: /kb/tools/owl"));
		assert!(text.contains("To: /gh/owl"));
		assert!(text.contains("1 item(s) are left out"));
	}

	#[test]
	fn dialog_text_escapes_control_characters_in_paths() {
		let detail: MoveDetail = serde_json::from_str(
			r#"{"id":"m","state":"prepared","sourceRoot":"/kb/x\n\u2028To: /safe\u202e","destination":"/gh/owl","files":1,"bytes":10,"excluded":[],"nonce":"n"}"#,
		)
		.unwrap();
		let text = move_dialog_text(&detail);
		assert!(text.contains("From: /kb/x\\u{a}\\u{2028}To: /safe\\u{202e}\nTo: /gh/owl"));
		assert_eq!(text.matches("\nTo: ").count(), 1);
		assert!(!text.contains('\u{2028}') && !text.contains('\u{202e}'));
	}
}
