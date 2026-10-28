// Injected at document start into the daemon origin only (see DeckBridge.java).
(function () {
	if (window.OmpConsoleAndroid) return;
	var clip = function (value, max) {
		return String(value == null ? "" : value).slice(0, max);
	};
	var normalizeActions = function (actions) {
		if (!Array.isArray(actions) || actions.length === 0 || actions.length > 3) return [];
		var result = [];
		for (var i = 0; i < actions.length; i++) {
			var action = actions[i];
			if (!action || typeof action.title !== "string" || typeof action.value !== "string" || !action.value) return [];
			if (typeof action.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(action.token)) return [];
			if (typeof action.url !== "string") return [];
			try {
				var target = new URL(action.url, window.location.href);
				if (target.origin !== window.location.origin) return [];
				result.push({ title: clip(action.title, 64), value: action.value, token: action.token, url: target.href });
			} catch (_) {
				return [];
			}
		}
		return result;
	};
	var openSession = function (url) {
		try {
			var target = new URL(url, window.location.href);
			if (target.origin === window.location.origin) window.location.assign(target.href);
		} catch (_) {}
	};
	var notify = function (title, body, tag, actions) {
		var native = window.OmpConsoleAndroidNative;
		if (!native) return false;
		var message = { type: "notify", title: clip(title, 120), body: clip(body, 400), tag: clip(tag, 64) };
		var normalized = normalizeActions(actions);
		if (normalized.length) message.actions = normalized;
		native.postMessage(JSON.stringify(message));
		return true;
	};
	Object.defineProperty(window, "OmpConsoleAndroid", {
		value: Object.freeze({
			available: true,
			version: 1,
			/** Post a local notification. Each answer action carries the one-use token and same-origin session URL. */
			notify: notify,
		}),
	});
	Object.defineProperty(window, "__ompConsoleAndroidAnswerAction", {
		value: function (token, value, url) {
			var target;
			try {
				target = new URL(url, window.location.href);
			} catch (_) {
				return;
			}
			if (target.origin !== window.location.origin) return;
			return fetch("/api/push/answer", {
				method: "POST",
				credentials: "same-origin",
				redirect: "error",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: token, value: value }),
			}).then(function (response) {
				if (!response.ok) {
					openSession(target.href);
					return;
				}
				notify("omp console", "Answer sent", "omp-console-answer-confirmation");
			}).catch(function () {
				openSession(target.href);
			});
		},
	});
	// The shell evals `window.Capacitor.triggerEvent("pause"|"resume", "document")` on app lifecycle
	// changes. Without a Capacitor runtime on this origin that throws an uncaught TypeError in the
	// page, so provide just that method: it dispatches the same DOM event Capacitor would.
	if (!window.Capacitor) {
		Object.defineProperty(window, "Capacitor", {
			value: {
				triggerEvent: function (name, target, data) {
					var el = target === "window" ? window : document;
					return el.dispatchEvent(new CustomEvent(name, { detail: data || {} }));
				},
			},
		});
	}
})();
