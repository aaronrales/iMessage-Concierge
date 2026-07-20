import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request emulator state. Lives in an AsyncLocalStorage so any code that
 * runs within an emulator request (sendToThread, proactive budget checks) can
 * detect it without having to pass a flag through every call stack.
 */
export interface EmulatorStore {
  /** All outbound messages captured during this emulator turn, in send order. */
  captured: Array<{ threadId: number; content: string; mediaUrl?: string }>;
}

export const emulatorStorage = new AsyncLocalStorage<EmulatorStore>();

/** True when the current async call chain is running inside an emulator request. */
export function isEmulatorMode(): boolean {
  return emulatorStorage.getStore() !== undefined;
}

/** Capture an outbound message in the current emulator store (no-op outside emulator). */
export function captureEmulatorMessage(threadId: number, content: string, mediaUrl?: string): void {
  const store = emulatorStorage.getStore();
  if (store) {
    store.captured.push({ threadId, content, mediaUrl });
  }
}
