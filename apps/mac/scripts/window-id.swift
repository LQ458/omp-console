import AppKit

import ApplicationServices
import Foundation

let bundleID = "dev.ompconsole.app"

let processID: Int32
if CommandLine.arguments.count > 1 {
	guard let requestedPID = Int32(CommandLine.arguments[1]) else {
		fputs("usage: swift window-id.swift [pid] [window-title]\n", stderr)
		exit(2)
	}
	processID = requestedPID
} else if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first {
	processID = app.processIdentifier
} else {
	fputs("omp console is not running.\n", stderr)
	exit(1)
}

let requestedWindowTitle = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : nil
guard CommandLine.arguments.count <= 3 else {
	fputs("usage: swift window-id.swift [pid] [window-title]\n", stderr)
	exit(2)
}

guard let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
	fputs("Could not enumerate on-screen windows.\n", stderr)
	exit(1)
}

let window = entries.first { entry in
	let nameMatches = requestedWindowTitle == nil || (entry[kCGWindowName as String] as? String) == requestedWindowTitle
	return (entry[kCGWindowOwnerPID as String] as? Int32) == processID &&
		(entry[kCGWindowLayer as String] as? Int) == 0 &&
		(entry[kCGWindowAlpha as String] as? Double ?? 0) > 0 &&
		nameMatches
}
guard let windowID = window?[kCGWindowNumber as String] as? UInt32 else {
	fputs("No visible omp console window found.\n", stderr)
	exit(1)
}
print(windowID)
