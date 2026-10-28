const { invoke } = window.__TAURI__.core;

const page = document.body.dataset.page;

if (page === "retry") {
	const message = document.querySelector("#message");
	const daemonUrl = document.querySelector("#daemon-url");
	const retry = document.querySelector("#retry");

	async function connect() {
		retry.disabled = true;
		message.textContent = "Checking the daemon…";
		try {
			const result = await invoke("connect_daemon");
			daemonUrl.textContent = result.url;
			if (!result.reachable) {
				message.textContent = `Unable to reach the daemon${result.error ? `: ${result.error}` : "."}`;
				retry.disabled = false;
			}
		} catch (error) {
			message.textContent = `Could not start the connection check: ${String(error)}`;
			retry.disabled = false;
		}
	}

	retry.addEventListener("click", connect);
	connect();
} else if (page === "settings") {
	const form = document.querySelector("#settings-form");
	const input = document.querySelector("#url");
	const stateDir = document.querySelector("#state-dir");
	const save = document.querySelector("#save");
	const error = document.querySelector("#error");

	invoke("get_daemon_settings").then(settings => {
		input.value = settings.daemonUrl;
		stateDir.value = settings.stateDir;
		input.focus();
		input.select();
	}).catch(reason => {
		error.textContent = String(reason);
	});

	form.addEventListener("submit", async event => {
		event.preventDefault();
		save.disabled = true;
		error.textContent = "";
		try {
			await invoke("save_daemon_settings", { url: input.value, stateDir: stateDir.value });
			window.close();
		} catch (reason) {
			error.textContent = String(reason);
			save.disabled = false;
		}
	});

	document.querySelector("#cancel").addEventListener("click", () => window.close());
}
