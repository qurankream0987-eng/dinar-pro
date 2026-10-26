/**
 * The conversation turn a piece of work belongs to (R3D). The turn route runs each turn inside
 * runInTurn; the action ledger stamps the rows a turn opens or settles with its id, so a turn's
 * receipts are exactly its own — never another request's concurrent outcome.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const turns = new AsyncLocalStorage<{ turnId: string }>();

export function runInTurn<T>(turnId: string, work: () => Promise<T>): Promise<T> {
  return turns.run({ turnId }, work);
}

export function currentTurnId(): string | undefined {
  return turns.getStore()?.turnId;
}
