import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { InteractiveModeContext } from "../types";
export declare class TanCommandController {
    private readonly ctx;
    constructor(ctx: Pick<InteractiveModeContext, "session" | "sessionManager" | "settings" | "mcpManager" | "showStatus" | "showError" | "rebuildChatFromMessages">);
    start(work: string, images?: ImageContent[]): Promise<{
        jobId: string;
        agentId: string;
    } | undefined>;
}
