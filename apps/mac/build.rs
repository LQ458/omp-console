fn main() {
	tauri_build::try_build(
		tauri_build::Attributes::new().app_manifest(
			tauri_build::AppManifest::new().commands(&[
				"connect_daemon",
				"get_daemon_settings",
				"save_daemon_settings",
				"read_pairing_code",
				"confirm_move",
				"native_notify",
				"automation_eval_result",
			]),
		),
	)
	.expect("failed to build Tauri application manifest");
}
