const ids = window.__deckHeaderSessionIds ?? ["pane-1", "pane-2", "pane-3", "pane-4"];
const selectors = [
	["sidebar", 'button[aria-label="toggle session list"]'],
	["session title", ".sh-title"],
	["connection dot", ".sh-status .sh-dot"],
	["model", 'button[title="change model (this session only)"]'],
	["thinking", 'button[title="change thinking level (this session only)"]'],
	["plan", 'button[aria-label^="Plan mode"]'],
	["approval", 'button[aria-label="Approval mode controls"]'],
	["settings", 'button[aria-label="settings"]'],
	["agents", 'button[aria-label="show agents"], button[aria-label="hide agents"]'],
	["activity", 'button[aria-label^="status:"]'],
	["new agent", 'button[aria-label="new agent"]'],
	["leave", 'button[aria-label="leave session"]'],
	["more controls", 'summary[aria-label="more session controls"]'],
];

for (let index = 0; index < ids.length; index++) {
	if (index === 0) await open(ids[index]);
	else {
		await splitRight();
		await open(ids[index], 1000);
	}
	await sleep(180);
	const frames = [...document.querySelectorAll(".pn-frame")];
	expect(frames.length === index + 1, `expected ${index + 1} panes, got ${frames.length}`);
	for (const frame of frames) {
		const header = frame.querySelector(".sh-header");
		if (!header) {
			expect(false, `${frame.dataset.pane}: missing header`);
			continue;
		}
		const bounds = header.getBoundingClientRect();
		for (const element of header.querySelectorAll("*")) {
			if (!element.getClientRects().length || element.closest(".sh-header-overflow-menu, .so-menu, .sc-pop, .dk-sheet-root")) continue;
			const rect = element.getBoundingClientRect();
			expect(
				rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1,
				`${frame.dataset.pane}: ${element.className || element.tagName} rect=${rect.left},${rect.top},${rect.right},${rect.bottom} exceeds header=${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`,
			);
		}
		for (const [name, selector] of selectors) {
			const overflow = header.querySelector(".sh-header-overflow");
			if (overflow) overflow.open = true;
			const matches = header.querySelectorAll(selector);
			expect(matches.length === 1, `${frame.dataset.pane}: ${name} has ${matches.length} mounted instances`);
			if (matches.length === 1) {
				const style = getComputedStyle(matches[0]);
				const rect = matches[0].getBoundingClientRect();
				expect(matches[0].getClientRects().length > 0, `${frame.dataset.pane}: ${name} is not visible (overflowOpen=${overflow?.open}, display=${style.display}, visibility=${style.visibility}, rect=${rect.left},${rect.top},${rect.width},${rect.height})`);
			}
		}
		const title = header.querySelector(".sh-title");
		const titleStyle = title ? getComputedStyle(title) : null;
		expect(Boolean(title?.textContent?.trim()), `${frame.dataset.pane}: session title is empty`);
		expect(titleStyle?.whiteSpace === "nowrap" && titleStyle.overflowX === "hidden" && titleStyle.textOverflow === "ellipsis", `${frame.dataset.pane}: session title is not ellipsized`);
		const plan = header.querySelector('button[aria-label^="Plan mode"]');
		const planState = plan?.querySelector(".so-plan-state")?.textContent?.trim();
		expect(["Unknown", "On", "Off"].includes(planState ?? ""), `${frame.dataset.pane}: Plan mode has an invalid state`);
		if (planState === "Unknown") expect(plan?.getAttribute("aria-pressed") === null, `${frame.dataset.pane}: unknown Plan mode state must not claim on or off`);
		if (planState === "On" || planState === "Off") expect(plan?.getAttribute("aria-pressed") === String(planState === "On"), `${frame.dataset.pane}: Plan mode state disagrees with aria-pressed`);
		expect(plan?.title.startsWith("Plan mode: the agent explores and writes a plan first; it edits files only after you approve the plan."), `${frame.dataset.pane}: Plan mode tooltip does not explain its effect`);
		const approvalControl = header.querySelector('button[aria-label="Approval mode controls"]');
		expect(approvalControl?.title.includes("No approval prompts lets every tool action run without asking."), `${frame.dataset.pane}: approval-mode tooltip does not explain its options`);

		const overflow = header.querySelector(".sh-header-overflow");
		if (overflow) overflow.open = false;
		const groups = [...header.children];
		for (const group of groups) {
			expect(group.scrollWidth <= group.clientWidth + 1, `${frame.dataset.pane}: ${group.className} clips an inline child (scroll=${group.scrollWidth}, client=${group.clientWidth}, header=${bounds.width})`);
		}
	}

	const header = frames.at(-1)?.querySelector(".sh-header");
	const overflow = header?.querySelector(".sh-header-overflow");
	if (!header || !overflow) continue;
	const more = header.querySelector('summary[aria-label="more session controls"]');
	more?.click();
	await sleep(50);
	expect(overflow.open, `${ids[index]}: clicking the more-controls trigger did not open its menu`);
	const overflowPanel = overflow.querySelector(".sh-header-overflow-menu");
	const paneFrame = header.closest(".pn-frame");
	expect(overflowPanel !== null && overflowPanel.getClientRects().length > 0, `${ids[index]}: overflow menu is not visible`);
	if (overflowPanel && paneFrame) {
		const rect = overflowPanel.getBoundingClientRect();
		const frameRect = paneFrame.getBoundingClientRect();
		expect(rect.left >= frameRect.left - 1 && rect.right <= frameRect.right + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1, `${ids[index]}: overflow menu rect=${rect.left},${rect.top},${rect.right},${rect.bottom} exceeds pane=${frameRect.left},${frameRect.top},${frameRect.right},${frameRect.bottom} or viewport=${innerWidth}x${innerHeight}`);
	}
	if (overflowPanel && header.dataset.overflowLevel !== "wide") {
		const directory = overflowPanel.querySelector(".sh-overflow-row .sh-cwd");
		const brand = overflowPanel.querySelector(".sh-overflow-row-content .sh-brand");
		expect(directory !== null && directory.textContent.trim().length > 0 && directory.getClientRects().length > 0, `${ids[index]}: moved directory readout is missing or hidden`);
		expect(brand !== null && brand.getClientRects().length > 0, `${ids[index]}: moved omp console identity is hidden`);
		const panelBounds = overflowPanel.getBoundingClientRect();
		const spilling = [...overflowPanel.querySelectorAll("*")]
			.filter(element => element.getBoundingClientRect().right > panelBounds.right + 1)
			.slice(0, 5)
			.map(element => `${element.tagName}.${typeof element.className === "string" ? element.className : ""} right=${element.getBoundingClientRect().right} text=${element.textContent?.trim().slice(0, 40)}`)
			.join("; ");
		expect(overflowPanel.scrollWidth <= overflowPanel.clientWidth + 1, `${ids[index]}: overflow menu has horizontal clipping (scroll=${overflowPanel.scrollWidth}, client=${overflowPanel.clientWidth}; ${spilling})`);
	}
	const model = header.querySelector('button[title="change model (this session only)"]');
	const modelInOverflow = Boolean(model?.closest(".sh-header-overflow"));
	expect(model !== null && !model.disabled, `${ids[index]}: model picker is disabled for this session`);
	if (!modelInOverflow) {
		more?.click();
		await sleep(50);
		expect(!overflow.open, `${ids[index]}: overflow menu should close before opening an inline model picker`);
	}
	model?.click();
	await sleep(100);
	const modelDialog = document.querySelector('.sc-pop[role="dialog"]');
	expect(modelDialog !== null, `${ids[index]}: model picker did not open from its inline or overflow trigger`);
	if (modelDialog) {
		const rect = modelDialog.getBoundingClientRect();
		expect(rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1, `${ids[index]}: model picker is clipped by the viewport`);
	}
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	await sleep(50);
	expect(!overflow.open, `${ids[index]}: Escape did not close the overflow menu after opening the model picker`);
	expect(document.querySelector(".sc-pop") === null, `${ids[index]}: Escape did not close the model picker`);
	more?.click();
	await sleep(50);
	expect(overflow.open, `${ids[index]}: more-controls trigger did not reopen the menu`);
	const approval = header.querySelector('button[aria-label="Approval mode controls"]');
	approval?.click();
	await sleep(50);
	const approvalMenu = document.querySelector(".so-menu");
	expect(approvalMenu !== null && approvalMenu.querySelector("select") !== null, `${ids[index]}: approval-mode menu did not open`);
	if (approvalMenu) {
		const rect = approvalMenu.getBoundingClientRect();
		const select = approvalMenu.querySelector("select");
		expect(select !== null && select.getClientRects().length > 0, `${ids[index]}: approval-mode selector is not visible`);
		expect(rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1, `${ids[index]}: approval-mode menu is clipped (${rect.left}, ${rect.top}, ${rect.right}, ${rect.bottom}; viewport ${innerWidth}x${innerHeight})`);
	}
	document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
	await sleep(50);
	expect(document.querySelector(".so-menu") === null, `${ids[index]}: outside pointer did not close the approval-mode popover`);
	if (!overflow.open) {
		more?.click();
		await sleep(50);
	}
	approval?.click();
	await sleep(50);
	expect(document.querySelector(".so-menu") !== null, `${ids[index]}: approval-mode popover did not reopen`);
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	await sleep(50);
	expect(document.querySelector(".so-menu") === null, `${ids[index]}: Escape did not close the approval-mode popover`);
	overflow.open = true;
	document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
	await sleep(30);
	expect(!overflow.open, `${ids[index]}: outside pointer did not close the overflow menu`);
	overflow.open = true;
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	await sleep(30);
	expect(!overflow.open, `${ids[index]}: Escape did not close the overflow menu`);
}
