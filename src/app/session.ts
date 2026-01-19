import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";

import type {
  Client,
  MessageWithParts,
  ModelRef,
  OpencodeEvent,
  PendingPermission,
  TodoItem,
} from "./types";
import {
  addOpencodeCacheHint,
  modelFromUserMessage,
  normalizeEvent,
  normalizeSessionStatus,
  removePart,
  upsertMessage,
  upsertPart,
  upsertSession,
} from "./utils";
import { unwrap } from "../lib/opencode";
import { getWorkerPool, type SSEProcessor } from "../lib/worker-pool";

export type SessionModelState = {
  overrides: Record<string, ModelRef>;
  resolved: Record<string, ModelRef>;
};

export type SessionStore = ReturnType<typeof createSessionStore>;

export function createSessionStore(options: {
  client: () => Client | null;
  selectedSessionId: () => string | null;
  setSelectedSessionId: (id: string | null) => void;
  sessionModelState: () => SessionModelState;
  setSessionModelState: (updater: (current: SessionModelState) => SessionModelState) => SessionModelState;
  lastUserModelFromMessages: (messages: MessageWithParts[]) => ModelRef | null;
  developerMode: () => boolean;
  setError: (message: string | null) => void;
  setSseConnected: (connected: boolean) => void;
}) {
  const [sessions, setSessions] = createSignal<Session[]>([]);
  const [sessionStatusById, setSessionStatusById] = createSignal<Record<string, string>>({});
  const [messages, setMessages] = createSignal<MessageWithParts[]>([]);
  const [todos, setTodos] = createSignal<TodoItem[]>([]);
  const [pendingPermissions, setPendingPermissions] = createSignal<PendingPermission[]>([]);
  const [permissionReplyBusy, setPermissionReplyBusy] = createSignal(false);
  const [events, setEvents] = createSignal<OpencodeEvent[]>([]);

  const addError = (error: unknown, fallback = "Unknown error") => {
    const message = error instanceof Error ? error.message : fallback;
    if (!message) return;
    options.setError(addOpencodeCacheHint(message));
  };

  const selectedSession = createMemo(() => {
    const id = options.selectedSessionId();
    if (!id) return null;
    return sessions().find((s) => s.id === id) ?? null;
  });

  const selectedSessionStatus = createMemo(() => {
    const id = options.selectedSessionId();
    if (!id) return "idle";
    return sessionStatusById()[id] ?? "idle";
  });

  async function loadSessions(scopeRoot?: string) {
    const c = options.client();
    if (!c) return;
    const list = unwrap(await c.session.list());
    const root = (scopeRoot ?? "").trim();
    const filtered = root ? list.filter((session) => session.directory === root) : list;
    setSessions(filtered);
  }

  async function refreshPendingPermissions() {
    const c = options.client();
    if (!c) return;
    const list = unwrap(await c.permission.list());
    setPendingPermissions((current) => {
      const now = Date.now();
      const byId = new Map(current.map((p) => [p.id, p] as const));
      return list.map((p) => ({ ...p, receivedAt: byId.get(p.id)?.receivedAt ?? now }));
    });
  }

  async function selectSession(sessionID: string) {
    const c = options.client();
    if (!c) return;

    options.setSelectedSessionId(sessionID);
    options.setError(null);

    const msgs = unwrap(await c.session.messages({ sessionID }));
    setMessages(msgs);

    const model = options.lastUserModelFromMessages(msgs);
    if (model) {
      options.setSessionModelState((current) => ({
        overrides: current.overrides,
        resolved: { ...current.resolved, [sessionID]: model },
      }));

      options.setSessionModelState((current) => {
        if (!current.overrides[sessionID]) return current;
        const copy = { ...current.overrides };
        delete copy[sessionID];
        return { ...current, overrides: copy };
      });
    }

    try {
      setTodos(unwrap(await c.session.todo({ sessionID })));
    } catch {
      setTodos([]);
    }

    try {
      await refreshPendingPermissions();
    } catch {
      // ignore
    }
  }

  async function respondPermission(requestID: string, reply: "once" | "always" | "reject") {
    const c = options.client();
    if (!c || permissionReplyBusy()) return;

    setPermissionReplyBusy(true);
    options.setError(null);

    try {
      unwrap(await c.permission.reply({ requestID, reply }));
      await refreshPendingPermissions();
    } catch (e) {
      addError(e);
    } finally {
      setPermissionReplyBusy(false);
    }
  }

  createEffect(() => {
    const c = options.client();
    if (!c) return;

    let cancelled = false;
    let workerDisconnected = false;

    // Process a single event from the worker
    const processEvent = (event: OpencodeEvent) => {
      batch(() => {
        if (event.type === "server.connected") {
          options.setSseConnected(true);
        }

        if (options.developerMode()) {
          setEvents((current) => {
            const next = [{ type: event.type, properties: event.properties }, ...current];
            return next.slice(0, 150);
          });
        }
      });

      batch(() => {
        if (event.type === "session.updated" || event.type === "session.created") {
          if (event.properties && typeof event.properties === "object") {
            const record = event.properties as Record<string, unknown>;
            if (record.info && typeof record.info === "object") {
              setSessions((current) => upsertSession(current, record.info as Session));
            }
          }
        }
      });

      batch(() => {
        if (event.type === "session.deleted") {
          if (event.properties && typeof event.properties === "object") {
            const record = event.properties as Record<string, unknown>;
            const info = record.info as Session | undefined;
            if (info?.id) {
              setSessions((current) => current.filter((s) => s.id !== info.id));
            }
          }
        }
      });

      batch(() => {
        if (event.type === "session.status") {
          if (event.properties && typeof event.properties === "object") {
            const record = event.properties as Record<string, unknown>;
            const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
            if (sessionID) {
              setSessionStatusById((current) => ({
                ...current,
                [sessionID]: normalizeSessionStatus(record.status),
              }));
            }
          }
        }
      });

      batch(() => {
        if (event.type === "session.idle") {
          if (event.properties && typeof event.properties === "object") {
            const record = event.properties as Record<string, unknown>;
            const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
            if (sessionID) {
              setSessionStatusById((current) => ({
                ...current,
                [sessionID]: "idle",
              }));
            }
          }
        }
      });

      batch(() => {
        if (event.type === "message.updated") {
          if (event.properties && typeof event.properties === "object") {
            const record = event.properties as Record<string, unknown>;
            if (record.info && typeof record.info === "object") {
              const info = record.info as Message;

              const model = modelFromUserMessage(info);
              if (model) {
                options.setSessionModelState((current) => ({
                  overrides: current.overrides,
                  resolved: { ...current.resolved, [info.sessionID]: model },
                }));

                options.setSessionModelState((current) => {
                  if (!current.overrides[info.sessionID]) return current;
                  const copy = { ...current.overrides };
                  delete copy[info.sessionID];
                  return { ...current, overrides: copy };
                });
              }

              if (options.selectedSessionId() && info.sessionID === options.selectedSessionId()) {
                setMessages((current) => upsertMessage(current, info));
              }
            }
          }
        }
      });

      batch(() => {
        if (event.type === "message.removed") {
          if (event.properties && typeof event.properties === "object") {
            const record = event.properties as Record<string, unknown>;
            if (
              options.selectedSessionId() &&
              record.sessionID === options.selectedSessionId() &&
              typeof record.messageID === "string"
            ) {
              setMessages((current) => current.filter((m) => m.info.id !== record.messageID));
            }
          }
        }
      });

      batch(() => {
        if (event.type === "message.part.updated") {
          if (event.properties && typeof event.properties === "object") {
            const record = event.properties as Record<string, unknown>;
            if (record.part && typeof record.part === "object") {
              const part = record.part as Part;
              if (options.selectedSessionId() && part.sessionID === options.selectedSessionId()) {
                setMessages((current) => {
                  const next = upsertPart(current, part);

                  if (typeof record.delta === "string" && record.delta && part.type === "text") {
                    const msgIdx = next.findIndex((m) => m.info.id === part.messageID);
                    if (msgIdx !== -1) {
                      const msg = next[msgIdx];
                      const parts = msg.parts.slice();
                      const pIdx = parts.findIndex((p) => p.id === part.id);
                      if (pIdx !== -1) {
                        const currentPart = parts[pIdx] as any;
                        if (typeof currentPart.text === "string" && currentPart.text.endsWith(record.delta) === false) {
                          parts[pIdx] = { ...(parts[pIdx] as any), text: `${currentPart.text}${record.delta}` };
                          const copy = next.slice();
                          copy[msgIdx] = { ...msg, parts };
                          return copy;
                        }
                      }
                    }
                  }

                  return next;
                });
              }
            }
          }
        }
      });

      batch(() => {
        if (event.type === "message.part.removed") {
          if (event.properties && typeof event.properties === "object") {
            const record = event.properties as Record<string, unknown>;
            const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
            const messageID = typeof record.messageID === "string" ? record.messageID : null;
            const partID = typeof record.partID === "string" ? record.partID : null;

            if (sessionID && options.selectedSessionId() && sessionID === options.selectedSessionId() && messageID && partID) {
              setMessages((current) => removePart(current, messageID, partID));
            }
          }
        }

        if (event.type === "todo.updated") {
          const id = options.selectedSessionId();
          if (id && event.properties && typeof event.properties === "object") {
            const record = event.properties as Record<string, unknown>;
            if (record.sessionID === id && Array.isArray(record.todos)) {
              setTodos(record.todos as any);
            }
          }
        }
      });

      if (event.type === "permission.asked" || event.type === "permission.replied") {
        refreshPendingPermissions().catch(() => {
          // ignore
        });
      }
    };

    // Process batched events from worker
    const processBatch = (batched: {
      messages: OpencodeEvent[];
      parts: OpencodeEvent[];
      sessions: OpencodeEvent[];
      todos: OpencodeEvent[];
      permissions: OpencodeEvent[];
      other: OpencodeEvent[];
    }) => {
      // Process all events in batch for optimal performance
      for (const event of batched.sessions) {
        if (cancelled) break;
        processEvent(event);
      }
      for (const event of batched.messages) {
        if (cancelled) break;
        processEvent(event);
      }
      for (const event of batched.parts) {
        if (cancelled) break;
        processEvent(event);
      }
      for (const event of batched.todos) {
        if (cancelled) break;
        processEvent(event);
      }
      for (const event of batched.permissions) {
        if (cancelled) break;
        processEvent(event);
      }
      for (const event of batched.other) {
        if (cancelled) break;
        processEvent(event);
      }
    };

    (async () => {
      try {
        const pool = getWorkerPool();
        const processor = await pool.getSSEProcessor();

        await processor.connect(
          () => c,
          processBatch,
          (error: Error) => {
            if (!cancelled && !workerDisconnected) {
              const message = error instanceof Error ? error.message : String(error);
              options.setError(message);
            }
          }
        );
      } catch (e) {
        if (cancelled) return;

        const message = e instanceof Error ? e.message : String(e);
        options.setError(message);
      }
    })();

    onCleanup(() => {
      cancelled = true;
      workerDisconnected = true;
    });
  });

  const activePermission = createMemo(() => {
    const id = options.selectedSessionId();
    const list = pendingPermissions();

    if (id) {
      return list.find((p) => p.sessionID === id) ?? null;
    }

    return list[0] ?? null;
  });

  return {
    sessions,
    sessionStatusById,
    selectedSession,
    selectedSessionStatus,
    messages,
    todos,
    pendingPermissions,
    permissionReplyBusy,
    events,
    activePermission,
    loadSessions,
    refreshPendingPermissions,
    selectSession,
    respondPermission,
    setSessions,
    setSessionStatusById,
    setMessages,
    setTodos,
    setPendingPermissions,
  };
}
