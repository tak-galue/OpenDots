import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventType, type Message, type BaseEvent } from '@ag-ui/core';
import {
  InMemoryAgentRunner,
  type AgentRunnerRunRequest,
  type AgentRunnerConnectRequest,
} from '@copilotkit/runtime/v2';
import { concat, from } from 'rxjs';
import type { WorkspaceStore } from './workspace.js';

// SQLite owns history; the SDK runner only owns the current streaming turn.
export class LocalConversations extends InMemoryAgentRunner {
  private db: DatabaseSync;
  private active = new Map<string, Promise<void>>();
  constructor(
    private workspace: WorkspaceStore,
    path: string,
  ) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS local_conversations (
        id TEXT PRIMARY KEY, messages TEXT NOT NULL, state TEXT NOT NULL
      );`);
  }
  close() {
    this.db.close();
  }
  async shutdown() {
    for (const threadId of this.active.keys()) await this.stop({ threadId });
    await Promise.all(this.active.values());
    this.close();
  }
  getThreadMessages(threadId: string): Message[] {
    this.workspace.requireThread(threadId);
    const row = this.db
      .prepare('SELECT messages FROM local_conversations WHERE id=?')
      .get(threadId) as { messages: string } | undefined;
    return row ? JSON.parse(row.messages) : [];
  }
  getThreadState(threadId: string): Record<string, unknown> {
    this.workspace.requireThread(threadId);
    const row = this.db
      .prepare('SELECT state FROM local_conversations WHERE id=?')
      .get(threadId) as { state: string } | undefined;
    return row ? JSON.parse(row.state) : {};
  }
  getThreadEvents(threadId: string): BaseEvent[] {
    return [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: this.getThreadMessages(threadId),
      },
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: this.getThreadState(threadId),
      },
    ];
  }
  private save(
    threadId: string,
    messages: Message[],
    state: Record<string, unknown>,
  ) {
    this.db
      .prepare(
        'INSERT INTO local_conversations VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET messages=excluded.messages, state=excluded.state',
      )
      .run(threadId, JSON.stringify(messages), JSON.stringify(state));
  }
  run(request: AgentRunnerRunRequest) {
    this.workspace.requireThread(request.threadId, request.agent.agentId);
    if (this.active.has(request.threadId))
      throw new Error('Conversation already running.');
    const stored = this.getThreadMessages(request.threadId);
    const ids = new Set(stored.map((m) => m.id));
    const pending = new Set(
      stored.flatMap((m) =>
        m.role === 'assistant' ? (m.toolCalls ?? []).map((t) => t.id) : [],
      ),
    );
    for (const m of stored) if (m.role === 'tool') pending.delete(m.toolCallId);
    const additions = request.input.messages.filter((m) => {
      if (ids.has(m.id)) return false;
      ids.add(m.id);
      return (
        m.role === 'user' || (m.role === 'tool' && pending.delete(m.toolCallId))
      );
    });
    const messages = [...stored, ...additions];
    const state = this.getThreadState(request.threadId);
    request.agent.setMessages(messages);
    request.agent.setState(state);
    this.save(request.threadId, messages, state);
    const events = super.run({
      ...request,
      input: { ...request.input, messages, state },
    });
    let finished: () => void = () => {};
    this.active.set(
      request.threadId,
      new Promise<void>((resolve) => {
        finished = resolve;
      }),
    );
    const complete = () => {
      try {
        this.save(
          request.threadId,
          request.agent.messages,
          request.agent.state,
        );
      } finally {
        this.active.delete(request.threadId);
        finished();
      }
    };
    // Persist even if the browser disconnects from its streaming response.
    events.subscribe({ complete, error: complete });
    return events;
  }
  connect(request: AgentRunnerConnectRequest) {
    this.workspace.requireThread(request.threadId, request.agentId);
    return this.active.has(request.threadId)
      ? concat(
          from(this.getThreadEvents(request.threadId)),
          super.connect(request),
        )
      : from(this.getThreadEvents(request.threadId));
  }
  listThreads() {
    return this.workspace.conversations().map((t) => ({
      id: t.id,
      name: t.title,
      agentId: t.dotId,
      organizationId: '' as const,
      createdById: '' as const,
      archived: false as const,
      createdAt: new Date(t.createdAt).toISOString(),
      updatedAt: new Date(t.createdAt).toISOString(),
    }));
  }
  clearThreads() {
    throw new Error('Local conversation deletion is not enabled.');
  }
}
