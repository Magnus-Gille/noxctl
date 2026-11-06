import type { ShadowQueue } from './queue.js';
import type { OperationObserver } from './types.js';

/** A trusted host supplies stable per-operation IDs; identical business payloads are not deduplicated. */
export function createQueueObserver(
  queue: ShadowQueue,
  intentId: (operation: string, args: unknown[]) => string,
): OperationObserver {
  return {
    execute: (operation, args, invoke) =>
      queue.execute({ id: intentId(operation, args), operation, args }, invoke),
    status: () => queue.status(),
  };
}
