import type { HostManager } from "../remote/host";
import { AgentAdapter, TurnRequest, TurnResult } from "./types";

/** Runs the turn on the machine named in `req.remote` (through its runner over ssh). */
export class RemoteAdapter implements AgentAdapter {
  constructor(private hosts: HostManager) {}

  runTurn(req: TurnRequest): Promise<TurnResult> {
    return this.hosts.runTurn(req);
  }
}
