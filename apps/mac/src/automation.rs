#[cfg(unix)]
use std::{
	ffi::OsString,
	os::unix::fs::{MetadataExt, PermissionsExt},
};
use std::{
	collections::HashMap,
	fs,
	path::{Path, PathBuf},
	sync::{
		Mutex,
		atomic::{AtomicU64, Ordering},
		mpsc::{self, Sender},
	},
	thread,
	time::Duration,
};
#[cfg(target_os = "macos")]
use std::process::Command;
#[cfg(target_os = "macos")]
use std::{ffi::c_void, ptr::NonNull};

#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2::{MainThreadMarker, runtime::AnyObject};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
	NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
};
#[cfg(target_os = "macos")]
use objc2_foundation::NSError;
#[cfg(target_os = "macos")]
use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, LogicalSize, Manager, WebviewWindow};
use url::Url;

const POLL_INTERVAL: Duration = Duration::from_millis(100);
const EVAL_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(target_os = "macos")]
const WINDOW_HANDLE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "macos")]
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(target_os = "macos")]
const SCREEN_CAPTURE: &str = "/usr/sbin/screencapture";

pub struct AutomationState {
	enabled:         bool,
	daemon_origin:   String,
	next_request_id: AtomicU64,
	pending:         Mutex<HashMap<String, Sender<Result<Value, String>>>>,
}

impl AutomationState {
	pub fn new(enabled: bool, daemon_origin: String) -> Self {
		Self {
			enabled,
			daemon_origin,
			next_request_id: AtomicU64::new(1),
			pending: Mutex::new(HashMap::new()),
		}
	}
}

#[derive(Deserialize)]
#[serde(tag = "op")]
enum AutomationCommand {
	#[serde(rename = "ping")]
	Ping,
	#[serde(rename = "resize")]
	Resize { width: f64, height: f64 },
	#[serde(rename = "bounds")]
	Bounds,
	#[serde(rename = "eval")]
	Eval { js: String },
	#[serde(rename = "snapshot")]
	Snapshot {
		path:   PathBuf,
		#[serde(default)]
		method: SnapshotMethod,
	},
	#[serde(rename = "reload")]
	Reload,
	#[serde(rename = "navigate")]
	Navigate { path: String },
}

#[derive(Default, Deserialize)]
enum SnapshotMethod {
	#[default]
	#[serde(rename = "webkit")]
	WebKit,
	#[serde(rename = "screencapture")]
	ScreenCapture,
}

#[cfg(unix)]
pub fn directory_from_env() -> Result<Option<PathBuf>, String> {
	directory_from_value(std::env::var_os("OMP_CONSOLE_AUTOMATION_DIR"), unsafe { libc::geteuid() })
}

/// The hook trusts the directory only after an owner and mode check that has no Windows equivalent here, so it stays off.
#[cfg(not(unix))]
pub fn directory_from_env() -> Result<Option<PathBuf>, String> {
	match std::env::var_os("OMP_CONSOLE_AUTOMATION_DIR") {
		None => Ok(None),
		Some(_) => Err("the automation hook is not supported on this platform".to_string()),
	}
}

#[cfg(unix)]
fn directory_from_value(
	value: Option<OsString>,
	expected_uid: u32,
) -> Result<Option<PathBuf>, String> {
	let Some(value) = value else {
		return Ok(None);
	};
	let path = PathBuf::from(value);
	validate_directory(&path, expected_uid)?;
	Ok(Some(path))
}

#[cfg(unix)]
fn validate_directory(path: &Path, expected_uid: u32) -> Result<(), String> {
	// lstat: the directory itself, never a symlink to one (its target could be swapped later).
	let metadata = fs::symlink_metadata(path)
		.map_err(|error| format!("automation directory is unavailable: {error}"))?;
	if metadata.file_type().is_symlink() {
		return Err("automation directory must not be a symlink".to_string());
	}
	if !metadata.is_dir() {
		return Err("automation path must be a directory".to_string());
	}
	if metadata.uid() != expected_uid {
		return Err("automation directory must be owned by the current user".to_string());
	}
	if metadata.permissions().mode() & 0o7777 != 0o700 {
		return Err("automation directory must have mode 0700".to_string());
	}
	Ok(())
}

pub fn prepare_directory(path: &Path) -> Result<(), String> {
	for name in ["cmd", "out"] {
		let child = path.join(name);
		match fs::symlink_metadata(&child) {
			Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
				return Err(format!("automation {name} path must be a real directory"));
			},
			Ok(_) => {},
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
				fs::create_dir(&child).map_err(|create_error| {
					format!("could not create automation {name} directory: {create_error}")
				})?;
			},
			Err(error) => {
				return Err(format!("could not inspect automation {name} directory: {error}"));
			},
		}
		#[cfg(unix)]
		fs::set_permissions(&child, fs::Permissions::from_mode(0o700))
			.map_err(|error| format!("could not secure automation {name} directory: {error}"))?;
	}
	Ok(())
}

pub fn start(app: AppHandle, directory: PathBuf, daemon_url: Url) -> Result<(), String> {
	thread::Builder::new()
		.name("omp-console-automation".to_string())
		.spawn(move || poll_commands(app, directory, daemon_url))
		.map_err(|error| format!("could not start automation poller: {error}"))?;
	Ok(())
}

pub fn accept_eval_result(
	window: &WebviewWindow,
	state: &AutomationState,
	request_id: String,
	result: Value,
) -> Result<(), String> {
	if !state.enabled {
		return Err("automation is disabled".to_string());
	}
	if window.label() != "main" {
		return Err("automation results are accepted only from the main window".to_string());
	}
	let origin = window
		.url()
		.map_err(|error| error.to_string())?
		.origin()
		.ascii_serialization();
	if origin != state.daemon_origin {
		return Err("automation results are accepted only from the configured daemon".to_string());
	}
	let object = result
		.as_object()
		.ok_or_else(|| "automation result must be an object".to_string())?;
	let value = if object.get("ok").and_then(Value::as_bool) == Some(true) {
		Ok(object.get("value").cloned().unwrap_or(Value::Null))
	} else {
		Err(
			object
				.get("error")
				.and_then(Value::as_str)
				.unwrap_or("JavaScript evaluation failed")
				.to_string(),
		)
	};
	let sender = state
		.pending
		.lock()
		.map_err(|_| "automation result lock is poisoned".to_string())?
		.remove(&request_id)
		.ok_or_else(|| "automation evaluation request is no longer pending".to_string())?;
	sender
		.send(value)
		.map_err(|_| "automation evaluation request timed out".to_string())
}

fn poll_commands(app: AppHandle, directory: PathBuf, daemon_url: Url) {
	let commands = directory.join("cmd");
	let outputs = directory.join("out");
	loop {
		let mut entries = match fs::read_dir(&commands) {
			Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
			Err(_) => {
				thread::sleep(POLL_INTERVAL);
				continue;
			},
		};
		entries.sort_by_key(std::fs::DirEntry::file_name);
		for entry in entries {
			let path = entry.path();
			if entry.file_type().is_ok_and(|file_type| file_type.is_file())
				&& path
					.extension()
					.is_some_and(|extension| extension == "json")
			{
				handle_command(&app, &daemon_url, &path, &outputs);
			}
		}
		thread::sleep(POLL_INTERVAL);
	}
}

fn handle_command(app: &AppHandle, daemon_url: &Url, path: &Path, outputs: &Path) {
	let name = match path.file_name() {
		Some(name) => name,
		None => return,
	};
	let output_path = outputs.join(name);
	let response = match fs::read_to_string(path) {
		Ok(text) => match serde_json::from_str::<AutomationCommand>(&text) {
			Ok(command) => execute_command(app, daemon_url, command),
			Err(error) => Err(format!("invalid automation command: {error}")),
		},
		Err(error) => Err(format!("could not read automation command: {error}")),
	};
	let output = match response {
		Ok(result) => json!({ "ok": true, "result": result }),
		Err(error) => json!({ "ok": false, "error": error }),
	};
	if write_output(&output_path, &output).is_ok() {
		let _ = fs::remove_file(path);
	}
}

fn write_output(path: &Path, value: &Value) -> Result<(), String> {
	let temporary = path.with_extension("json.tmp");
	let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
	fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
	fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn execute_command(
	app: &AppHandle,
	daemon_url: &Url,
	command: AutomationCommand,
) -> Result<Value, String> {
	let window = app
		.get_webview_window("main")
		.ok_or_else(|| "main webview is unavailable".to_string())?;
	match command {
		AutomationCommand::Ping => Ok(json!({
			"version": env!("CARGO_PKG_VERSION"),
			"daemon_url": daemon_url.as_str(),
		})),
		AutomationCommand::Resize { width, height } => {
			if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
				return Err("resize dimensions must be finite positive numbers".to_string());
			}
			window
				.set_size(LogicalSize::new(width, height))
				.map_err(|error| error.to_string())?;
			window_bounds(&window)
		},
		AutomationCommand::Bounds => window_bounds(&window),
		AutomationCommand::Eval { js } => {
			let origin = window
				.url()
				.map_err(|error| error.to_string())?
				.origin()
				.ascii_serialization();
			if origin != daemon_url.origin().ascii_serialization() {
				return Err(
					"JavaScript evaluation is available only on the configured daemon origin"
						.to_string(),
				);
			}
			evaluate(&window, app.state::<AutomationState>().inner(), &js)
		},
		AutomationCommand::Snapshot { path, method } => snapshot(&window, &path, method),
		AutomationCommand::Reload => {
			window.reload().map_err(|error| error.to_string())?;
			Ok(json!({ "reloaded": true }))
		},
		AutomationCommand::Navigate { path } => {
			if !path.starts_with('/')
				|| path.starts_with("//")
				|| path.contains('?')
				|| path.contains('#')
			{
				return Err(
					"navigate requires a single-origin absolute path without query or fragment"
						.to_string(),
				);
			}
			let mut target = daemon_url.clone();
			target.set_path(&path);
			target.set_query(None);
			target.set_fragment(None);
			window
				.navigate(target.clone())
				.map_err(|error| error.to_string())?;
			Ok(json!({ "path": path, "url": target.as_str() }))
		},
	}
}

fn window_bounds(window: &WebviewWindow) -> Result<Value, String> {
	let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
	let position = window
		.outer_position()
		.map_err(|error| error.to_string())?
		.to_logical::<f64>(scale_factor);
	let size = window
		.inner_size()
		.map_err(|error| error.to_string())?
		.to_logical::<f64>(scale_factor);
	#[cfg(target_os = "macos")]
	let window_number = Some(native_window_number(window)?);
	#[cfg(not(target_os = "macos"))]
	let window_number: Option<u32> = None;
	Ok(json!({
		"position": { "x": position.x, "y": position.y },
		"size": { "width": size.width, "height": size.height },
		"scale_factor": scale_factor,
		"window_number": window_number,
	}))
}

fn evaluate(window: &WebviewWindow, state: &AutomationState, js: &str) -> Result<Value, String> {
	let request_id =
		format!("{}-{}", std::process::id(), state.next_request_id.fetch_add(1, Ordering::Relaxed));
	let (sender, receiver) = mpsc::channel();
	state
		.pending
		.lock()
		.map_err(|_| "automation result lock is poisoned".to_string())?
		.insert(request_id.clone(), sender);
	let id_json = serde_json::to_string(&request_id).map_err(|error| error.to_string())?;
	let script = format!(
		r#"(async()=>{{
			const requestId={id_json};
			const send=result=>window.__TAURI__.core.invoke("automation_eval_result",{{requestId,result}});
			try {{
				const value=await (async()=>({js}))();
				const serialized=value===undefined?null:JSON.parse(JSON.stringify(value));
				await send({{ok:true,value:serialized}});
			}} catch(error) {{
				await send({{ok:false,error:String(error)}});
			}}
		}})();"#
	);
	if let Err(error) = window.eval(&script) {
		remove_pending(state, &request_id);
		return Err(error.to_string());
	}
	match receiver.recv_timeout(EVAL_TIMEOUT) {
		Ok(result) => result,
		Err(error) => {
			remove_pending(state, &request_id);
			Err(format!("JavaScript evaluation timed out or disconnected: {error}"))
		},
	}
}

fn remove_pending(state: &AutomationState, request_id: &str) {
	if let Ok(mut pending) = state.pending.lock() {
		pending.remove(request_id);
	}
}

fn snapshot(window: &WebviewWindow, path: &Path, method: SnapshotMethod) -> Result<Value, String> {
	if !path.is_absolute()
		|| !path
			.extension()
			.is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
	{
		return Err("snapshot path must be an absolute .png path".to_string());
	}
	match method {
		SnapshotMethod::WebKit => {
			#[cfg(target_os = "macos")]
			{
				snapshot_webkit(window, path)
			}
			#[cfg(not(target_os = "macos"))]
			{
				Err("WKWebView snapshots are available only on macOS".to_string())
			}
		},
		SnapshotMethod::ScreenCapture => snapshot_screencapture(window, path),
	}
}

#[cfg(target_os = "macos")]
fn snapshot_webkit(window: &WebviewWindow, path: &Path) -> Result<Value, String> {
	let (sender, receiver) = mpsc::channel();
	window
		.with_webview(move |webview| {
			let webview_pointer = webview.inner();
			let native_window = webview.ns_window();
			if webview_pointer.is_null() || native_window.is_null() {
				let _ =
					sender.send(Err("Tauri returned an empty WKWebView or NSWindow handle".to_string()));
				return;
			}
			let Some(main_thread) = MainThreadMarker::new() else {
				let _ = sender
					.send(Err("WKWebView snapshot must be requested on the main thread".to_string()));
				return;
			};
			let native_window = unsafe { &*native_window.cast::<AnyObject>() };
			// Public AppKit ordering requests rendering without activating or
			// keying omp console.app.
			unsafe {
				let _: () = objc2::msg_send![native_window, orderFrontRegardless];
				let _: () = objc2::msg_send![native_window, displayIfNeeded];
			}
			// SAFETY: Tauri invokes this callback on the main thread, as confirmed
			// by `main_thread`.
			let configuration = unsafe { WKSnapshotConfiguration::new(main_thread) };
			// SAFETY: The configuration belongs to this main-thread snapshot
			// request.
			unsafe { configuration.setAfterScreenUpdates(true) };
			let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
				let _ = sender.send(snapshot_png_bytes(image, error));
			});
			let webview = unsafe { &*webview_pointer.cast::<WKWebView>() };
			unsafe {
				webview
					.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &completion);
			}
		})
		.map_err(|error| format!("could not access WKWebView for snapshot: {error}"))?;
	let png_bytes = receiver
		.recv_timeout(SNAPSHOT_TIMEOUT)
		.map_err(|error| format!("WKWebView snapshot timed out: {error}"))??;
	fs::write(path, &png_bytes)
		.map_err(|error| format!("could not write WKWebView snapshot: {error}"))?;
	snapshot_metadata(path, "WKWebView.takeSnapshotWithConfiguration", None, &png_bytes)
}

#[cfg(target_os = "macos")]
fn snapshot_png_bytes(image: *mut NSImage, error: *mut NSError) -> Result<Vec<u8>, String> {
	if image.is_null() {
		return Err(if error.is_null() {
			"WKWebView snapshot returned no image".to_string()
		} else {
			"WKWebView snapshot failed".to_string()
		});
	}
	let image = unsafe { &*image };
	let tiff = image
		.TIFFRepresentation()
		.ok_or_else(|| "WKWebView snapshot image has no TIFF representation".to_string())?;
	let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)
		.ok_or_else(|| "could not decode WKWebView snapshot image".to_string())?;
	let properties = objc2_foundation::NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
	let png_data =
		unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) }
			.ok_or_else(|| "could not encode WKWebView snapshot as PNG".to_string())?;
	let length = usize::try_from(png_data.length())
		.map_err(|_| "WKWebView snapshot PNG is too large".to_string())?;
	if length == 0 {
		return Err("WKWebView snapshot PNG is empty".to_string());
	}
	let mut bytes = vec![0; length];
	let buffer = NonNull::new(bytes.as_mut_ptr().cast::<c_void>())
		.ok_or_else(|| "could not allocate WKWebView snapshot PNG buffer".to_string())?;
	unsafe {
		png_data.getBytes_length(buffer, length as _);
	}
	Ok(bytes)
}

#[cfg(target_os = "macos")]
fn snapshot_screencapture(window: &WebviewWindow, path: &Path) -> Result<Value, String> {
	let window_number = native_window_number(window)?;
	let output = Command::new(SCREEN_CAPTURE)
		.arg("-x")
		.arg("-l")
		.arg(window_number.to_string())
		.arg(path)
		.output()
		.map_err(|error| format!("could not start screencapture: {error}"))?;
	if !output.status.success() {
		return Err(format!(
			"screencapture failed: {}",
			String::from_utf8_lossy(&output.stderr).trim()
		));
	}
	let png_bytes =
		fs::read(path).map_err(|error| format!("could not read screencapture PNG: {error}"))?;
	snapshot_metadata(path, "screencapture -l", Some(window_number), &png_bytes)
}
#[cfg(not(target_os = "macos"))]
fn snapshot_screencapture(_window: &WebviewWindow, _path: &Path) -> Result<Value, String> {
	Err("Screen capture snapshots are available only on macOS".to_string())
}

#[cfg(target_os = "macos")]
fn snapshot_metadata(
	path: &Path,
	method: &str,
	window_number: Option<u32>,
	png_bytes: &[u8],
) -> Result<Value, String> {
	let (blank, width, height) = png_blank_info(png_bytes)?;
	Ok(json!({
		"path": path,
		"window_number": window_number,
		"method": method,
		"blank": blank,
		"size": { "width": width, "height": height },
	}))
}

fn png_blank_info(png_bytes: &[u8]) -> Result<(bool, u32, u32), String> {
	let mut decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
	decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
	let mut reader = decoder
		.read_info()
		.map_err(|error| format!("could not decode snapshot PNG: {error}"))?;
	let output_size = reader
		.output_buffer_size()
		.ok_or_else(|| "snapshot PNG exceeds the addressable image size".to_string())?;
	let mut decoded = vec![0; output_size];
	let info = reader
		.next_frame(&mut decoded)
		.map_err(|error| format!("could not decode snapshot PNG: {error}"))?;
	if info.bit_depth != png::BitDepth::Eight {
		return Err(format!("unsupported snapshot PNG bit depth: {:?}", info.bit_depth));
	}
	let channels = match info.color_type {
		png::ColorType::Grayscale => 1,
		png::ColorType::Rgb => 3,
		png::ColorType::GrayscaleAlpha => 2,
		png::ColorType::Rgba => 4,
		png::ColorType::Indexed => return Err("snapshot PNG palette was not expanded".to_string()),
	};
	let pixels = decoded
		.get(..info.buffer_size())
		.ok_or_else(|| "snapshot PNG decoder returned an incomplete image".to_string())?;
	if pixels.len() % channels != 0 {
		return Err("snapshot PNG has an incomplete pixel".to_string());
	}
	let mut min_channels = [u8::MAX; 4];
	let mut max_channels = [u8::MIN; 4];
	for pixel in pixels.chunks_exact(channels) {
		for (index, channel) in pixel.iter().enumerate() {
			min_channels[index] = min_channels[index].min(*channel);
			max_channels[index] = max_channels[index].max(*channel);
		}
	}
	// Each channel range can span four levels while all pixels remain within two
	// of a common midpoint.
	let blank = (0..channels)
		.all(|index| u16::from(max_channels[index]) - u16::from(min_channels[index]) <= 4);
	Ok((blank, info.width, info.height))
}

#[cfg(target_os = "macos")]
fn native_window_number(window: &WebviewWindow) -> Result<u32, String> {
	let (sender, receiver) = mpsc::channel();
	window
		.with_webview(move |webview| {
			let native_window = webview.ns_window();
			let result = if native_window.is_null() {
				Err("Tauri returned an empty native window handle".to_string())
			} else {
				let object = unsafe { &*native_window.cast::<objc2::runtime::AnyObject>() };
				let number: isize = unsafe { objc2::msg_send![object, windowNumber] };
				u32::try_from(number).map_err(|_| "native window number is invalid".to_string())
			};
			let _ = sender.send(result);
		})
		.map_err(|error| error.to_string())?;
	receiver
		.recv_timeout(WINDOW_HANDLE_TIMEOUT)
		.map_err(|error| format!("could not obtain the native window number: {error}"))?
}


#[cfg(all(test, unix))]
mod tests {
	use std::{
		fs,
		os::unix::fs::PermissionsExt,
		path::PathBuf,
		time::{SystemTime, UNIX_EPOCH},
	};

	use super::{directory_from_value, png_blank_info, validate_directory};

	fn encode_rgb_png(pixels: &[u8]) -> Vec<u8> {
		let mut bytes = Vec::new();
		{
			let mut encoder = png::Encoder::new(&mut bytes, 2, 1);
			encoder.set_color(png::ColorType::Rgb);
			encoder.set_depth(png::BitDepth::Eight);
			let mut writer = encoder.write_header().unwrap();
			writer.write_image_data(pixels).unwrap();
			writer.finish().unwrap();
		}
		bytes
	}

	#[test]
	fn blank_snapshot_uses_a_two_level_per_channel_tolerance() {
		let within_tolerance = encode_rgb_png(&[10, 20, 30, 14, 24, 34]);
		assert_eq!(png_blank_info(&within_tolerance).unwrap(), (true, 2, 1));

		let outside_tolerance = encode_rgb_png(&[10, 20, 30, 15, 24, 34]);
		assert_eq!(png_blank_info(&outside_tolerance).unwrap(), (false, 2, 1));
	}

	fn test_directory(name: &str, mode: u32) -> PathBuf {
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap()
			.as_nanos();
		let path = std::env::temp_dir()
			.join(format!("omp-console-automation-{name}-{}-{suffix}", std::process::id()));
		fs::create_dir(&path).unwrap();
		fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
		path
	}

	#[test]
	fn automation_is_off_without_the_environment_variable() {
		assert_eq!(directory_from_value(None, unsafe { libc::geteuid() }).unwrap(), None);
	}

	#[test]
	fn automation_rejects_a_missing_directory() {
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap()
			.as_nanos();
		let missing = std::env::temp_dir()
			.join(format!("omp-console-automation-missing-{}-{suffix}", std::process::id()));
		let error = validate_directory(&missing, unsafe { libc::geteuid() }).unwrap_err();
		assert!(error.starts_with("automation directory is unavailable:"));
	}

	#[test]
	fn automation_rejects_a_directory_with_the_wrong_mode() {
		let path = test_directory("mode", 0o750);
		let result = validate_directory(&path, unsafe { libc::geteuid() });
		fs::remove_dir_all(path).unwrap();
		assert_eq!(result.unwrap_err(), "automation directory must have mode 0700");
	}

	#[test]
	fn automation_rejects_a_symlink_to_a_valid_directory() {
		let target = test_directory("symlink-target", 0o700);
		let link = target.with_extension("link");
		std::os::unix::fs::symlink(&target, &link).unwrap();
		let result = directory_from_value(Some(link.as_os_str().to_os_string()), unsafe { libc::geteuid() });
		fs::remove_file(&link).unwrap();
		fs::remove_dir_all(target).unwrap();
		assert_eq!(result.unwrap_err(), "automation directory must not be a symlink");
	}

	#[test]
	fn automation_rejects_an_owner_uid_mismatch() {
		let path = test_directory("owner", 0o700);
		let current_uid = unsafe { libc::geteuid() };
		let other_uid = if current_uid == u32::MAX {
			current_uid - 1
		} else {
			current_uid + 1
		};
		let result = directory_from_value(Some(path.as_os_str().to_os_string()), other_uid);
		fs::remove_dir_all(path).unwrap();
		assert_eq!(result.unwrap_err(), "automation directory must be owned by the current user");
	}
}
