import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";

const cursorSdkMock = vi.hoisted(() => {
  const closeExecutionOrder: Array<string> = [];
  const runOperations: Array<string> = [];
  let agentCloseFailure: unknown;
  let staleRunActive = false;
  const runWait = vi.fn(async () => ({
    id: "run-cursor-agent-sdk-test",
    requestId: "request-cursor-agent-sdk-test",
    status: "finished",
    result: "ok",
    model: { id: "default" },
    durationMs: 1,
  }));
  const runCancel = vi.fn(async () => {});
  const agentClose = vi.fn(() => {
    closeExecutionOrder.push("sdk:agent.close");
    if (agentCloseFailure !== undefined) {
      throw agentCloseFailure;
    }
  });
  const send = vi.fn(
    async (
      _message: unknown,
      options: { readonly onDelta?: (input: { readonly update: unknown }) => Promise<void> },
    ) => {
      runOperations.push("run.start");
      if (staleRunActive) {
        throw new Error("Agent agent-cursor-agent-sdk-test already has active run");
      }
      await options.onDelta?.({
        update: {
          type: "assistant-message-chunk",
          text: "hello",
        },
      });
      return {
        id: "run-cursor-agent-sdk-test",
        agentId: "agent-cursor-agent-sdk-test",
        wait: runWait,
        cancel: runCancel,
      };
    },
  );
  const create = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const resume = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const listRuns = vi.fn(async () => {
    runOperations.push("agent.listRuns");
    return {
      items: staleRunActive ? [{ id: "run-stale", status: "running" }] : [],
    };
  });
  const cancelRun = vi.fn(async () => {
    runOperations.push("agent.cancelRun");
    staleRunActive = false;
  });

  const getDefaultSdkStateRoot = vi.fn(
    (cwd: string) =>
      `C:\\Users\\felip\\.cursor\\projects\\${cwd.replace(/[^a-zA-Z0-9]+/g, "-")}\\sdk-agent-store\\${"a".repeat(64)}`,
  );
  const openStore = vi.fn(async () => ({ kind: "short-windows-store" }));

  return {
    agentClose,
    getDefaultSdkStateRoot,
    openStore,
    cancelRun,
    closeExecutionOrder,
    create,
    listRuns,
    resume,
    runOperations,
    runCancel,
    runWait,
    send,
    setAgentCloseFailure: (failure: unknown) => {
      agentCloseFailure = failure;
    },
    setStaleRunActive: (active: boolean) => {
      staleRunActive = active;
    },
  };
});

vi.mock("./sdk.ts", () => ({
  Agent: {
    create: cursorSdkMock.create,
    resume: cursorSdkMock.resume,
    listRuns: cursorSdkMock.listRuns,
    cancelRun: cursorSdkMock.cancelRun,
    messages: {
      list: vi.fn(async () => []),
    },
  },
  createAgentPlatform: vi.fn(),
  getDefaultSdkStateRoot: cursorSdkMock.getDefaultSdkStateRoot,
  SqliteLocalAgentStore: { open: cursorSdkMock.openStore },
}));

const layerTest = CursorAgentSdk.layer.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
      native: {
        filePath: "cursor-agent-sdk-test.log",
        write: (event: unknown) =>
          Effect.sync(() => {
            if (
              typeof event === "object" &&
              event !== null &&
              Reflect.get(Reflect.get(event, "event"), "payload")?.type === "agent.close"
            ) {
              cursorSdkMock.closeExecutionOrder.push("protocol:agent.close");
            }
          }),
        close: () => Effect.void,
      },
      canonical: undefined,
    }),
  ),
  Layer.provide(CursorSdk.layer),
  Layer.provide(NodeServices.layer),
);

describe("CursorAgentSdkRunner", () => {
  it.effect("retries a resumed send after cancelling its abandoned local run", () =>
    Effect.gen(function* () {
      cursorSdkMock.runOperations.length = 0;
      cursorSdkMock.listRuns.mockClear();
      cursorSdkMock.cancelRun.mockClear();
      cursorSdkMock.setStaleRunActive(true);

      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "resume",
        agentId: "agent-cursor-agent-sdk-test",
        options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
        threadId: ThreadId.make("thread-cursor-agent-sdk-stale-run-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-stale-run-test",
        ),
      });
      assert.deepStrictEqual(cursorSdkMock.runOperations, []);
      const run = yield* session.send({ message: "continue" });
      yield* run.wait;

      assert.deepStrictEqual(cursorSdkMock.runOperations, [
        "run.start",
        "agent.listRuns",
        "agent.cancelRun",
        "run.start",
      ]);
      assert.deepStrictEqual(cursorSdkMock.listRuns.mock.calls[0], [
        "agent-cursor-agent-sdk-test",
        { runtime: "local", cwd: process.cwd(), limit: 1 },
      ]);
      assert.deepStrictEqual(cursorSdkMock.cancelRun.mock.calls[0], [
        "run-stale",
        {
          runtime: "local",
          cwd: process.cwd(),
        },
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps Windows agent stores under MAX_PATH for deep workspaces", () =>
    Effect.gen(function* () {
      cursorSdkMock.resume.mockClear();
      cursorSdkMock.openStore.mockClear();
      const deepCwd = "C:\\Users\\felip\\OneDrive\\Documentos\\GitHub\\Dungoban.Monogame";
      const runner = yield* CursorAgentSdk.makeCursorAgentSdkRunner(() => undefined).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.HomeDirectory, "C:\\Users\\felip"),
      );
      const open = (cwd: string) =>
        runner.open({
          operation: "resume",
          agentId: "agent-cursor-agent-sdk-test",
          options: { model: { id: "default" }, mode: "agent", local: { cwd } },
          threadId: ThreadId.make("thread-cursor-agent-sdk-windows-store-test"),
          providerSessionId: ProviderSessionId.make(
            "provider-session-cursor-agent-sdk-windows-store-test",
          ),
        });

      yield* open(deepCwd);
      yield* open(deepCwd);
      yield* open("C:\\src\\game");

      assert.deepStrictEqual(cursorSdkMock.openStore.mock.calls, [
        [
          {
            workspaceRef: deepCwd,
            stateRoot: `C:\\Users\\felip\\.t3\\cursor-sdk\\${"a".repeat(16)}`,
          },
        ],
      ]);
      const stores = cursorSdkMock.resume.mock.calls.map(
        (call) => (call as unknown as [string, { local: { store?: unknown } }])[1].local.store,
      );
      assert.deepStrictEqual(stores, [
        { kind: "short-windows-store" },
        { kind: "short-windows-store" },
        undefined,
      ]);
    }).pipe(Effect.provide(CursorSdk.layer)),
  );
});
