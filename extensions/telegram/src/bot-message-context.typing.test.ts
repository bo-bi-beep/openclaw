// Telegram tests cover bot message context.typing plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import type { TelegramChannelIngressResolver } from "./bot-message-context.types.js";
import type { TelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";

function requireInvocationOrder(mock: { invocationCallOrder: number[] }, context: string): number {
  return expectDefined(mock.invocationCallOrder[0], context);
}

function createSendChatActionHandler(
  sendChatAction = vi.fn<TelegramSendChatActionHandler["sendChatAction"]>(async () => undefined),
): TelegramSendChatActionHandler & { sendChatAction: typeof sendChatAction } {
  return {
    sendChatAction,
    isSuspended: () => false,
    reset: () => undefined,
  };
}

describe("buildTelegramMessageContext typing", () => {
  it("sends direct typing after body resolution and before session context construction", async () => {
    const buildInboundContext = vi.fn(
      (params: Parameters<typeof buildChannelInboundEventContext>[0]) =>
        buildChannelInboundEventContext(params as never),
    );
    const sendChatActionHandler = createSendChatActionHandler();

    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Pat" },
        from: { id: 42, first_name: "Pat" },
        text: "hello",
      },
      sendChatActionHandler,
      sessionRuntime: {
        buildChannelInboundEventContext:
          buildInboundContext as unknown as typeof buildChannelInboundEventContext,
      },
    });

    expect(context).not.toBeNull();
    expect(sendChatActionHandler.sendChatAction).toHaveBeenCalledWith(
      42,
      "typing",
      undefined,
      expect.any(AbortSignal),
    );
    expect(
      requireInvocationOrder(sendChatActionHandler.sendChatAction.mock, "send typing invocation"),
    ).toBeLessThan(requireInvocationOrder(buildInboundContext.mock, "inbound context invocation"));
    context?.typingHeartbeat?.cleanup();
  });

  it("refreshes typing while inbound context resolution is pending", async () => {
    vi.useFakeTimers();
    let releaseIngress!: () => void;
    const ingressPending = new Promise<void>((resolve) => {
      releaseIngress = resolve;
    });
    const resolveChannelIngress = vi.fn<TelegramChannelIngressResolver>(async () => {
      await ingressPending;
      return {} as never;
    });
    const sendChatActionHandler = createSendChatActionHandler();
    const contextPromise = buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Pat" },
        from: { id: 42, first_name: "Pat" },
        text: "hello",
      },
      options: { channelIngressResolvers: [resolveChannelIngress] },
      sendChatActionHandler,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(resolveChannelIngress).toHaveBeenCalledOnce();
      expect(sendChatActionHandler.sendChatAction).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(sendChatActionHandler.sendChatAction).toHaveBeenCalledTimes(2);
    } finally {
      releaseIngress();
      const context = await contextPromise;
      context?.typingHeartbeat?.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("stops refreshing while session context construction is pending when its owner aborts", async () => {
    vi.useFakeTimers();
    let releaseIngress!: () => void;
    const ingressPending = new Promise<void>((resolve) => {
      releaseIngress = resolve;
    });
    const ownerAbortController = new AbortController();
    const resolveChannelIngress = vi.fn<TelegramChannelIngressResolver>(async () => {
      await ingressPending;
      return {} as never;
    });
    const sendChatActionHandler = createSendChatActionHandler();
    const contextPromise = buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Pat" },
        from: { id: 42, first_name: "Pat" },
        text: "hello",
      },
      options: { channelIngressResolvers: [resolveChannelIngress] },
      sendChatActionHandler,
      typingAbortSignal: ownerAbortController.signal,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(sendChatActionHandler.sendChatAction).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      ownerAbortController.abort(new Error("Gateway interrupted"));
      await vi.advanceTimersByTimeAsync(8_000);

      expect(sendChatActionHandler.sendChatAction).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseIngress();
      const context = await contextPromise;
      context?.typingHeartbeat?.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("aborts an in-flight early cue when session context construction fails", async () => {
    let typingSignal: AbortSignal | undefined;
    const sendChatAction = vi.fn<TelegramSendChatActionHandler["sendChatAction"]>(
      async (_chatId, _action, _threadParams, signal) => {
        typingSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );
    const sendChatActionHandler = createSendChatActionHandler(sendChatAction);
    const contextError = new Error("context construction failed");

    await expect(
      buildTelegramMessageContextForTest({
        message: {
          chat: { id: 42, type: "private", first_name: "Pat" },
          from: { id: 42, first_name: "Pat" },
          text: "hello",
        },
        sendChatActionHandler,
        sessionRuntime: {
          buildChannelInboundEventContext: vi.fn(() => {
            throw contextError;
          }),
        },
      }),
    ).rejects.toBe(contextError);

    expect(typingSignal).toBeInstanceOf(AbortSignal);
    expect(typingSignal?.aborted).toBe(true);
  });

  it("does not send direct typing when there is no replyable body", async () => {
    const sendChatActionHandler = createSendChatActionHandler();

    await expect(
      buildTelegramMessageContextForTest({
        message: {
          chat: { id: 42, type: "private", first_name: "Pat" },
          from: { id: 42, first_name: "Pat" },
          text: undefined,
        },
        sendChatActionHandler,
      }),
    ).resolves.toBeNull();

    expect(sendChatActionHandler.sendChatAction).not.toHaveBeenCalled();
  });

  it("does not send early direct typing before DM access passes", async () => {
    const sendChatActionHandler = createSendChatActionHandler();

    await expect(
      buildTelegramMessageContextForTest({
        message: {
          chat: { id: 42, type: "private", first_name: "Pat" },
          from: { id: 42, first_name: "Pat" },
          text: "hello",
        },
        cfg: {
          agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
          channels: { telegram: { dmPolicy: "disabled", allowFrom: [] } },
          messages: { groupChat: { mentionPatterns: [] } },
        },
        dmPolicy: "disabled",
        sendChatActionHandler,
      }),
    ).resolves.toBeNull();

    expect(sendChatActionHandler.sendChatAction).not.toHaveBeenCalled();
  });

  it("sends forum topic typing after accepted user-request classification and before context construction", async () => {
    const buildInboundContext = vi.fn(
      (params: Parameters<typeof buildChannelInboundEventContext>[0]) =>
        buildChannelInboundEventContext(params as never),
    );
    const sendChatActionHandler = createSendChatActionHandler();

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
        from: { id: 42, first_name: "Pat" },
        message_thread_id: 99,
        text: "hello topic",
      },
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
      sendChatActionHandler,
      sessionRuntime: {
        buildChannelInboundEventContext:
          buildInboundContext as unknown as typeof buildChannelInboundEventContext,
      },
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("user_request");
    expect(ctx?.typingHeartbeat).toBeDefined();
    expect(sendChatActionHandler.sendChatAction).toHaveBeenCalledWith(
      -1001234567890,
      "typing",
      { message_thread_id: 99 },
      expect.any(AbortSignal),
    );
    expect(
      requireInvocationOrder(sendChatActionHandler.sendChatAction.mock, "send typing invocation"),
    ).toBeLessThan(requireInvocationOrder(buildInboundContext.mock, "inbound context invocation"));
    ctx?.typingHeartbeat?.cleanup();
  });

  it("waits for dispatch recovery before typing into a forum with no explicit topic", async () => {
    const sendChatActionHandler = createSendChatActionHandler();

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
        from: { id: 42, first_name: "Pat" },
        text: "hello recovered topic",
      },
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
      sendChatActionHandler,
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("user_request");
    expect(ctx?.typingHeartbeat).toBeDefined();
    expect(sendChatActionHandler.sendChatAction).not.toHaveBeenCalled();
    ctx?.typingHeartbeat?.cleanup();
  });

  it("does not send forum topic typing for room events", async () => {
    const sendChatActionHandler = createSendChatActionHandler();

    const ctx = await buildTelegramMessageContextForTest({
      cfg: { messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } } },
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
        from: { id: 42, first_name: "Pat" },
        message_thread_id: 99,
        text: "ambient chatter",
      },
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
      sendChatActionHandler,
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("room_event");
    expect(ctx?.typingHeartbeat).toBeUndefined();
    expect(sendChatActionHandler.sendChatAction).not.toHaveBeenCalled();
  });

  it("binds buffered ingress in order to the final route, message, and room-event kind", async () => {
    const resolutionOrder: string[] = [];
    const createResolver = (label: string) =>
      vi.fn<TelegramChannelIngressResolver>(async () => {
        resolutionOrder.push(label);
        return {} as never;
      });
    const first = createResolver("first");
    const last = createResolver("last");
    const buildInboundContext = vi.fn(
      (params: Parameters<typeof buildChannelInboundEventContext>[0]) =>
        buildChannelInboundEventContext(params as never),
    );

    const ctx = await buildTelegramMessageContextForTest({
      cfg: { messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } } },
      message: {
        message_id: 101,
        chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
        from: { id: 42, first_name: "Pat" },
        message_thread_id: 99,
        text: "ambient chatter",
      },
      options: {
        messageIdOverride: "102",
        channelIngressResolvers: [first, last],
      },
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
      sessionRuntime: {
        buildChannelInboundEventContext:
          buildInboundContext as unknown as typeof buildChannelInboundEventContext,
      },
    });

    const expectedBinding = {
      agentId: ctx?.route.agentId,
      sessionKey: ctx?.route.sessionKey,
      messageId: "102",
      inboundEventKind: "room_event",
    };
    expect(resolutionOrder).toEqual(["first", "last"]);
    expect(first).toHaveBeenCalledExactlyOnceWith(expectedBinding);
    expect(last).toHaveBeenCalledExactlyOnceWith(expectedBinding);
    expect(ctx?.ctxPayload.MessageSid).toBe("102");
    expect(buildInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          routePeer: { kind: "group", id: "-1001234567890:topic:99" },
          parentId: "-1001234567890",
        }),
      }),
    );
  });

  it("does not send forum topic typing for unaddressed require-mention messages", async () => {
    const sendChatActionHandler = createSendChatActionHandler();

    await expect(
      buildTelegramMessageContextForTest({
        message: {
          chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
          from: { id: 42, first_name: "Pat" },
          message_thread_id: 99,
          text: "ambient chatter",
        },
        resolveGroupRequireMention: () => true,
        resolveTelegramGroupConfig: () => ({
          groupConfig: { requireMention: true },
          topicConfig: undefined,
        }),
        sendChatActionHandler,
      }),
    ).resolves.toBeNull();

    expect(sendChatActionHandler.sendChatAction).not.toHaveBeenCalled();
  });
});
