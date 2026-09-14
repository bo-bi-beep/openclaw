import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import {
  createChannelMessageReplyPipeline,
  createContext,
  createRuntime,
  createStatusReactionController,
  dispatchReplyWithBufferedBlockDispatcher,
  describeTelegramDispatch,
  dispatchWithContext,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";
import { telegramInboundEventDelivery } from "./inbound-event-delivery.js";

const settledDispatchResult = {
  queuedFinal: false,
  counts: { block: 0, final: 0, tool: 0 },
};

function installTypingPipeline(start: () => Promise<void>) {
  createChannelMessageReplyPipeline.mockReturnValueOnce({
    responsePrefix: undefined,
    responsePrefixContextProvider: () => ({ identityName: undefined }),
    resolveResponsePrefix: () => undefined,
    onModelSelected: () => undefined,
    typingCallbacks: createTypingCallbacks({
      start,
      keepaliveIntervalMs: 4_000,
      maxDurationMs: 0,
      maxConsecutiveFailures: 5,
      onStartError: vi.fn(),
    }),
  });
}

describeTelegramDispatch("dispatchTelegramMessage pipeline-init", () => {
  it("keeps the owning Gateway reply dispatcher on the assembled inbound turn", async () => {
    const dispatchReplyFromConfig = vi.fn();

    await dispatchWithContext({
      context: createContext(),
      opts: {
        token: "token",
        dispatchReplyFromConfig,
      } as Parameters<typeof dispatchWithContext>[0]["opts"],
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchReplyFromConfig }),
    );
  });

  it("does not enter the reply pipeline after the durable owner aborts", async () => {
    const abortController = new AbortController();
    abortController.abort(new Error("handler-timeout"));

    await expect(
      dispatchWithContext({
        context: createContext(),
        turnAdoptionLifecycle: {
          abortSignal: abortController.signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onAbandoned: vi.fn(),
        },
      }),
    ).resolves.toEqual({ kind: "completed" });

    expect(createChannelMessageReplyPipeline).not.toHaveBeenCalled();
  });

  it("keeps one Telegram-owned typing loop below the client expiry", async () => {
    vi.useFakeTimers();
    try {
      const dispatch = createDeferred<typeof settledDispatchResult>();
      const context = createContext({ sendTyping: vi.fn(async () => undefined) });
      installTypingPipeline(context.sendTyping);
      dispatchReplyWithBufferedBlockDispatcher.mockReturnValueOnce(dispatch.promise);

      const processing = dispatchWithContext({ context });
      await vi.advanceTimersByTimeAsync(0);

      expect(context.sendTyping).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      expect(createChannelMessageReplyPipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          typing: expect.objectContaining({
            keepaliveIntervalMs: 4_000,
            maxDurationMs: 0,
          }),
        }),
      );
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
        expect.objectContaining({
          replyOptions: expect.objectContaining({ typingKeepalive: false }),
        }),
      );

      const dispatchArgs = dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
      await dispatchArgs?.dispatcherOptions?.typingCallbacks?.onReplyStart();
      expect(context.sendTyping).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(3_999);
      expect(context.sendTyping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(context.sendTyping).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(context.sendTyping).toHaveBeenCalledTimes(3);

      dispatch.resolve(settledDispatchResult);
      await expect(processing).resolves.toEqual({ kind: "completed" });
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(8_000);
      expect(context.sendTyping).toHaveBeenCalledTimes(3);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("adopts the eager intake cue without sending a duplicate action", async () => {
    vi.useFakeTimers();
    try {
      const dispatch = createDeferred<typeof settledDispatchResult>();
      const sendTyping = vi.fn(async () => undefined);
      await sendTyping();
      const context = createContext({ initialTypingCueAtMs: Date.now(), sendTyping });
      installTypingPipeline(sendTyping);
      dispatchReplyWithBufferedBlockDispatcher.mockReturnValueOnce(dispatch.promise);

      const processing = dispatchWithContext({ context });
      await vi.advanceTimersByTimeAsync(0);

      expect(sendTyping).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      const dispatchArgs = dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
      await dispatchArgs?.dispatcherOptions?.typingCallbacks?.onReplyStart();
      expect(sendTyping).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(3_999);
      expect(sendTyping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sendTyping).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);

      dispatch.resolve(settledDispatchResult);
      await expect(processing).resolves.toEqual({ kind: "completed" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("stops retrying a failed Telegram chat-action transport", async () => {
    vi.useFakeTimers();
    try {
      const dispatch = createDeferred<typeof settledDispatchResult>();
      const sendTyping = vi.fn(async () => {
        throw new Error("chat action unavailable");
      });
      installTypingPipeline(sendTyping);
      dispatchReplyWithBufferedBlockDispatcher.mockReturnValueOnce(dispatch.promise);

      const processing = dispatchWithContext({ context: createContext({ sendTyping }) });
      await vi.advanceTimersByTimeAsync(16_000);

      expect(sendTyping).toHaveBeenCalledTimes(5);
      expect(vi.getTimerCount()).toBe(0);

      dispatch.resolve(settledDispatchResult);
      await expect(processing).resolves.toEqual({ kind: "completed" });
      await vi.advanceTimersByTimeAsync(8_000);
      expect(sendTyping).toHaveBeenCalledTimes(5);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("stops typing promptly when the Gateway cancels an active turn", async () => {
    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const dispatch = createDeferred<typeof settledDispatchResult>();
      const sendTyping = vi.fn(async () => undefined);
      installTypingPipeline(sendTyping);
      dispatchReplyWithBufferedBlockDispatcher.mockReturnValueOnce(dispatch.promise);

      const processing = dispatchWithContext({
        context: createContext({ sendTyping }),
        turnAdoptionLifecycle: {
          abortSignal: abortController.signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onAbandoned: vi.fn(),
        },
      });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(sendTyping).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);

      abortController.abort(new Error("Gateway interrupted"));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(8_000);
      expect(sendTyping).toHaveBeenCalledTimes(2);

      dispatch.resolve(settledDispatchResult);
      await expect(processing).resolves.toEqual({ kind: "completed" });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("restarts one clean typing loop when an interrupted source turn is replayed", async () => {
    vi.useFakeTimers();
    try {
      const sourcePayload = {
        MessageSid: "source-turn-1",
        SessionKey: "agent:default:telegram:direct:123",
      } as TelegramMessageContext["ctxPayload"];
      const interrupted = createDeferred<typeof settledDispatchResult>();
      const firstSendTyping = vi.fn(async () => undefined);
      installTypingPipeline(firstSendTyping);
      dispatchReplyWithBufferedBlockDispatcher.mockReturnValueOnce(interrupted.promise);

      const firstProcessing = dispatchWithContext({
        context: createContext({ ctxPayload: sourcePayload, sendTyping: firstSendTyping }),
        retryDispatchErrors: true,
        suppressFailureFallback: true,
      });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(firstSendTyping).toHaveBeenCalledTimes(2);

      interrupted.reject(new Error("Gateway interrupted"));
      await expect(firstProcessing).resolves.toEqual({
        kind: "failed-retryable",
        error: expect.objectContaining({ message: "Gateway interrupted" }),
      });
      expect(vi.getTimerCount()).toBe(0);

      const resumed = createDeferred<typeof settledDispatchResult>();
      const resumedSendTyping = vi.fn(async () => undefined);
      installTypingPipeline(resumedSendTyping);
      dispatchReplyWithBufferedBlockDispatcher.mockReturnValueOnce(resumed.promise);
      const resumedProcessing = dispatchWithContext({
        context: createContext({ ctxPayload: sourcePayload, sendTyping: resumedSendTyping }),
      });
      await vi.advanceTimersByTimeAsync(4_000);

      expect(firstSendTyping).toHaveBeenCalledTimes(2);
      expect(resumedSendTyping).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);

      resumed.resolve(settledDispatchResult);
      await expect(resumedProcessing).resolves.toEqual({ kind: "completed" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps overlapping chat runs isolated when one settles first", async () => {
    vi.useFakeTimers();
    try {
      const first = createDeferred<typeof settledDispatchResult>();
      const second = createDeferred<typeof settledDispatchResult>();
      const firstSendTyping = vi.fn(async () => undefined);
      const secondSendTyping = vi.fn(async () => undefined);
      installTypingPipeline(firstSendTyping);
      installTypingPipeline(secondSendTyping);
      dispatchReplyWithBufferedBlockDispatcher
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);

      const firstProcessing = dispatchWithContext({
        context: createContext({
          ctxPayload: { MessageSid: "overlap-1" } as TelegramMessageContext["ctxPayload"],
          sendTyping: firstSendTyping,
        }),
      });
      const secondProcessing = dispatchWithContext({
        context: createContext({
          ctxPayload: { MessageSid: "overlap-2" } as TelegramMessageContext["ctxPayload"],
          sendTyping: secondSendTyping,
        }),
      });
      await vi.advanceTimersByTimeAsync(4_000);

      expect(firstSendTyping).toHaveBeenCalledTimes(2);
      expect(secondSendTyping).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(2);

      first.resolve(settledDispatchResult);
      await expect(firstProcessing).resolves.toEqual({ kind: "completed" });
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(firstSendTyping).toHaveBeenCalledTimes(2);
      expect(secondSendTyping).toHaveBeenCalledTimes(3);

      second.resolve(settledDispatchResult);
      await expect(secondProcessing).resolves.toEqual({ kind: "completed" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("cleans delivery correlation when reply-pipeline initialization fails", async () => {
    const sessionKey = "agent:main:telegram:direct:pipeline-init-failure";
    const statusReactionController = createStatusReactionController();
    const reactionApi = vi.fn(async () => undefined);
    const runtime = createRuntime();
    runtime.error = vi.fn(() => {
      telegramInboundEventDelivery.notify({
        sessionKey,
        to: "123",
        accountId: "default",
      });
    });
    createChannelMessageReplyPipeline.mockImplementationOnce(() => {
      throw new Error("pipeline initialization failed");
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: sessionKey,
          ChatType: "direct",
        } as TelegramMessageContext["ctxPayload"],
        statusReactionController: statusReactionController as never,
        reactionApi,
      }),
      runtime,
      suppressFailureFallback: true,
    });

    await vi.waitFor(() => {
      expect(statusReactionController.restoreInitial).toHaveBeenCalled();
    });
    expect(reactionApi).not.toHaveBeenCalled();
  });
});
