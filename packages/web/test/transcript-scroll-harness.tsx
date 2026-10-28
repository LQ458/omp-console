import { useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { createRoot } from "react-dom/client";
import { Transcript } from "../src/components/transcript/Transcript";
import type { TranscriptScrollPosition } from "../src/components/transcript/Transcript";
import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/components/transcript/transcript.css";

const entries: readonly SessionEntry[] = Array.from({ length: 1_200 }, (_, index) => ({
	type: "message",
	id: `entry-${index}`,
	parentId: index === 0 ? null : `entry-${index - 1}`,
	timestamp: "2026-07-15T00:00:00Z",
	message: { role: "user", content: `message-${index}`, timestamp: index },
}));

function TranscriptScrollHarness(): ReactNode {
	const [split, setSplit] = useState(false);
	const [savedAnchor, setSavedAnchor] = useState("");
	const positionRef = useRef<TranscriptScrollPosition | undefined>(undefined);
	return (
		<main data-pane-mode={split ? "split" : "single"}>
			<button type="button" onClick={() => setSplit(value => !value)}>Toggle split panes</button>
			<output data-testid="saved-scroll-anchor">{savedAnchor}</output>
			<div style={{ height: "560px", width: split ? "360px" : "740px" }}>
				<Transcript
					key={split ? "split" : "single"}
					entries={entries}
					stream={null}
					streamDone
					activeTools={new Map()}
					working={false}
					initialScrollPosition={positionRef.current}
					onScrollPositionChange={position => {
						positionRef.current = position;
						setSavedAnchor(position.anchor?.key ?? "");
					}}
				/>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root === null) throw new Error("transcript scroll harness root is missing");
createRoot(root).render(<TranscriptScrollHarness />);
