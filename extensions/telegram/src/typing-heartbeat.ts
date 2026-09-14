import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-outbound";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { TELEGRAM_CHAT_ACTION_INTERVAL_MS } from "./chat-action-timing.js";

const TELEGRAM_MAX_CONSECUTIVE_TYPING_FAILURES = 5;

type TelegramTypingSender = (signal?: AbortSignal) => Promise<void>;

export type TelegramTypingHeartbeat = {
  cleanup: () => void;
  rebind: (sendTyping: TelegramTypingSender) => void;
  start: () => void;
};

export function createTelegramTypingHeartbeat(params: {
  chatId: number | string;
  sendTyping: TelegramTypingSender;
  abortController?: AbortController;
  abortSignal?: AbortSignal;
}): TelegramTypingHeartbeat {
  const abortController = params.abortController ?? new AbortController();
  let sendTyping = params.sendTyping;
  let started = false;
  let cleaned = false;
  const handleStartError = (error: unknown) => {
    if (abortController.signal.aborted) {
      return;
    }
    logTypingFailure({
      log: logVerbose,
      channel: "telegram",
      target: String(params.chatId),
      error,
    });
  };
  const callbacks = createTypingCallbacks({
    start: () => sendTyping(abortController.signal),
    keepaliveIntervalMs: TELEGRAM_CHAT_ACTION_INTERVAL_MS,
    maxDurationMs: 0,
    maxConsecutiveFailures: TELEGRAM_MAX_CONSECUTIVE_TYPING_FAILURES,
    onStartError: handleStartError,
  });
  const cleanup = (reason?: unknown) => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    params.abortSignal?.removeEventListener("abort", handleOwnerAbort);
    abortController.abort(reason);
    callbacks.onCleanup?.();
  };
  const handleOwnerAbort = () => cleanup(params.abortSignal?.reason);
  if (params.abortSignal?.aborted) {
    handleOwnerAbort();
  } else {
    params.abortSignal?.addEventListener("abort", handleOwnerAbort, { once: true });
  }

  return {
    start: () => {
      if (started || cleaned) {
        return;
      }
      started = true;
      void callbacks.onReplyStart().catch(handleStartError);
    },
    rebind: (nextSendTyping) => {
      if (!cleaned) {
        sendTyping = nextSendTyping;
      }
    },
    cleanup,
  };
}
