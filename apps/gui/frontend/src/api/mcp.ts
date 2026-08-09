const MCP_PROTOCOL_VERSION = "2025-06-18";

type JsonObject = Record<string, unknown>;

type SocketEvent = { data?: unknown };

export interface McpSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: SocketEvent) => void,
  ): void;
}

export type McpSocketFactory = (url: string, protocols: string[]) => McpSocket;

export type McpClientOptions = {
  url: string;
  protocols?: string[];
  clientName?: string;
  clientVersion?: string;
  socketFactory?: McpSocketFactory;
};

export type McpToolResult<T extends JsonObject> = {
  content?: { type: string; text?: string }[];
  isError?: boolean;
  structuredContent?: T;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type NotificationHandler = (params: unknown) => void;

const defaultSocketFactory: McpSocketFactory = (url, protocols) =>
  new WebSocket(url, protocols) as McpSocket;

const errorMessage = (value: unknown): string => {
  if (!value || typeof value !== "object") return "MCP request failed";
  const message = (value as JsonObject).message;
  return typeof message === "string" && message ? message : "MCP request failed";
};

const toolErrorMessage = (result: McpToolResult<JsonObject>): string =>
  result.content?.find((entry) => entry.type === "text" && entry.text)?.text ??
  "MCP tool call failed";

/**
 * Minimal browser MCP client over WebSocket.
 *
 * It owns only MCP framing, request correlation, tool calls, and notifications.
 * Authentication and application command naming stay with the selected backend
 * adapter, so the same client can serve AgencyProxy now and the headless
 * AgencyZero service later.
 */
export class McpWebSocketClient {
  private readonly options: Required<Pick<McpClientOptions, "clientName" | "clientVersion">> &
    McpClientOptions;
  private readonly socketFactory: McpSocketFactory;
  private socket: McpSocket | undefined;
  private connecting: Promise<void> | undefined;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notifications = new Map<string, Set<NotificationHandler>>();

  constructor(options: McpClientOptions) {
    this.options = {
      clientName: "agencyzero-web",
      clientVersion: "0",
      ...options,
    };
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
  }

  connect(): Promise<void> {
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = this.socketFactory(this.options.url, this.options.protocols ?? []);
      this.socket = socket;
      let opened = false;

      socket.addEventListener("message", (event) => this.handleMessage(event.data));
      socket.addEventListener("close", () => {
        this.socket = undefined;
        this.connecting = undefined;
        this.rejectPending(new Error("MCP connection closed"));
        if (!opened) reject(new Error("MCP connection closed before initialization"));
      });
      socket.addEventListener("error", () => {
        if (!opened) reject(new Error("MCP connection failed"));
      });
      socket.addEventListener("open", () => {
        opened = true;
        void this.initialize().then(resolve, reject);
      });
    });

    return this.connecting;
  }

  close(): void {
    this.socket?.close(1000, "client closed");
    this.socket = undefined;
    this.connecting = undefined;
    this.rejectPending(new Error("MCP client closed"));
  }

  async callTool<T extends JsonObject>(
    name: string,
    args: JsonObject = {},
  ): Promise<McpToolResult<T>> {
    await this.connect();
    const result = await this.request<McpToolResult<T>>("tools/call", {
      name,
      arguments: args,
    });
    if (result.isError) throw new Error(toolErrorMessage(result));
    return result;
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    const handlers = this.notifications.get(method) ?? new Set<NotificationHandler>();
    handlers.add(handler);
    this.notifications.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.notifications.delete(method);
    };
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: this.options.clientName,
        version: this.options.clientVersion,
      },
    });
    this.notify("notifications/initialized");
  }

  private request<T>(method: string, params?: JsonObject): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      } catch (cause) {
        this.pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  private notify(method: string, params?: JsonObject): void {
    this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  private send(frame: JsonObject): void {
    if (!this.socket) throw new Error("MCP client is not connected");
    this.socket.send(JSON.stringify(frame));
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let frame: JsonObject;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      frame = parsed as JsonObject;
    } catch {
      return;
    }

    if (typeof frame.id === "number") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (frame.error !== undefined) pending.reject(new Error(errorMessage(frame.error)));
      else pending.resolve(frame.result);
      return;
    }

    if (typeof frame.method !== "string") return;
    for (const handler of this.notifications.get(frame.method) ?? []) handler(frame.params);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

export const agencyProxyProtocols = (authenticationKey: string): string[] => [
  `agency-proxy.${authenticationKey}`,
];
