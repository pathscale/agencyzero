import { describe, expect, it } from "vitest";
import {
  agencyProxyProtocols,
  type McpSocket,
  type McpSocketFactory,
  McpWebSocketClient,
} from "./mcp";

type Listener = (event: { data?: unknown }) => void;

class FakeSocket implements McpSocket {
  readonly sent: Record<string, unknown>[] = [];
  readonly listeners = new Map<string, Listener[]>();

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.emit("close");
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }

  reply(id: number, result: unknown): void {
    this.emit("message", JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  fail(id: number, message: string): void {
    this.emit("message", JSON.stringify({ jsonrpc: "2.0", id, error: { code: -1, message } }));
  }
}

const connectedClient = async () => {
  const socket = new FakeSocket();
  let openedUrl = "";
  let openedProtocols: string[] = [];
  const socketFactory: McpSocketFactory = (url, protocols) => {
    openedUrl = url;
    openedProtocols = protocols;
    return socket;
  };
  const client = new McpWebSocketClient({
    url: "wss://proxy.example.test/mcp",
    protocols: agencyProxyProtocols("test-key"),
    clientName: "adapter-test",
    clientVersion: "1",
    socketFactory,
  });
  const connecting = client.connect();
  socket.emit("open");
  socket.reply(1, {
    protocolVersion: "2025-06-18",
    serverInfo: { name: "agency-proxy", version: "0.1.4" },
    capabilities: { tools: {} },
  });
  await connecting;
  return { client, socket, openedUrl, openedProtocols };
};

describe("McpWebSocketClient", () => {
  it("authenticates with the selected WebSocket protocol and performs the MCP handshake", async () => {
    const { socket, openedUrl, openedProtocols } = await connectedClient();

    expect(openedUrl).toBe("wss://proxy.example.test/mcp");
    expect(openedProtocols).toEqual(["agency-proxy.test-key"]);
    expect(socket.sent[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "adapter-test", version: "1" },
      },
    });
    expect(socket.sent[1]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
  });

  it("correlates tool calls and returns structured MCP content", async () => {
    const { client, socket } = await connectedClient();

    const result = client.callTool<{ runs: unknown[] }>("list_runs");
    await Promise.resolve();
    expect(socket.sent[2]).toMatchObject({
      id: 2,
      method: "tools/call",
      params: { name: "list_runs", arguments: {} },
    });
    socket.reply(2, { isError: false, structuredContent: { runs: [] } });

    await expect(result).resolves.toMatchObject({ structuredContent: { runs: [] } });
  });

  it("surfaces JSON-RPC and MCP tool errors", async () => {
    const { client, socket } = await connectedClient();

    const rpcFailure = client.callTool("list_runs");
    await Promise.resolve();
    socket.fail(2, "not authorized");
    await expect(rpcFailure).rejects.toThrow("not authorized");

    const toolFailure = client.callTool("start_run");
    await Promise.resolve();
    socket.reply(3, {
      isError: true,
      content: [{ type: "text", text: "workspace denied" }],
    });
    await expect(toolFailure).rejects.toThrow("workspace denied");
  });

  it("delivers and unsubscribes from MCP notifications", async () => {
    const { client, socket } = await connectedClient();
    const seen: unknown[] = [];
    const unlisten = client.onNotification("notifications/run_event", (params) =>
      seen.push(params),
    );

    socket.emit(
      "message",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/run_event",
        params: { runId: "run-1", sequence: 4 },
      }),
    );
    unlisten();
    socket.emit(
      "message",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/run_event",
        params: { runId: "run-1", sequence: 5 },
      }),
    );

    expect(seen).toEqual([{ runId: "run-1", sequence: 4 }]);
  });

  it("rejects pending calls when the connection closes", async () => {
    const { client, socket } = await connectedClient();
    const pending = client.callTool("list_runs");
    await Promise.resolve();

    socket.emit("close");

    await expect(pending).rejects.toThrow("MCP connection closed");
  });
});
