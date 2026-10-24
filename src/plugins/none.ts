import type { AgentRoomPlugin } from "../core/plugins";

/** The plugins bundled into this build. The public build has none; esbuild swaps in `private.ts` when that file exists. */
export const plugins: AgentRoomPlugin[] = [];
