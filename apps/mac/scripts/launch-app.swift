import ApplicationServices
import Foundation

func visibleWindowID(for pid: Int32) -> UInt32? {
	guard let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
		return nil
	}
	return entries.first { entry in
		(entry[kCGWindowOwnerPID as String] as? Int32) == pid &&
		(entry[kCGWindowLayer as String] as? Int) == 0 &&
		(entry[kCGWindowAlpha as String] as? Double ?? 0) > 0
	}?[kCGWindowNumber as String] as? UInt32
}

guard CommandLine.arguments.count == 4 else {
	fputs("usage: swift launch-app.swift <app-executable> <daemon-url> <url-file>\n", stderr)
	exit(2)
}

let executable = URL(fileURLWithPath: CommandLine.arguments[1])
let daemonURL = CommandLine.arguments[2]
let urlFile = URL(fileURLWithPath: CommandLine.arguments[3])
do {
	try FileManager.default.createDirectory(at: urlFile.deletingLastPathComponent(), withIntermediateDirectories: true)
	try daemonURL.write(to: urlFile, atomically: true, encoding: .utf8)
} catch {
	fputs("could not prepare one-shot daemon URL: \(error)\n", stderr)
	exit(1)
}

let process = Process()
process.executableURL = executable
var environment = ProcessInfo.processInfo.environment
environment["OMP_CONSOLE_DAEMON_URL_FILE"] = urlFile.path
process.environment = environment
let startedAt = ProcessInfo.processInfo.systemUptime
do {
	try process.run()
} catch {
	fputs("could not launch omp console: \(error)\n", stderr)
	exit(1)
}

let deadline = startedAt + 30
while ProcessInfo.processInfo.systemUptime < deadline {
	if let windowID = visibleWindowID(for: process.processIdentifier) {
		let elapsedMilliseconds = (ProcessInfo.processInfo.systemUptime - startedAt) * 1000
		print("pid=\(process.processIdentifier) window_id=\(windowID) launch_to_first_window_ms=\(Int(elapsedMilliseconds.rounded()))")
		exit(0)
	}
	if !process.isRunning {
		fputs("omp console exited before its first window (status \(process.terminationStatus)).\n", stderr)
		exit(1)
	}
	Thread.sleep(forTimeInterval: 0.025)
}
process.terminate()
fputs("omp console did not create a visible window within 30 seconds.\n", stderr)
exit(1)
