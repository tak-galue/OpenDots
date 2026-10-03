import { lastValueFrom, tap } from 'rxjs';
import { currentTurnText } from './headless.js';
import { LocalConversations } from './local-conversations.js';
import { CodexClient } from './codex-client.js';
import { ComputerService } from './computer-service.js';
import { PageService } from './page-service.js';
import { randomUUID } from 'node:crypto';
import {
  CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotHonoHandler,
  type CopilotHonoApp,
} from '@copilotkit/runtime/v2';
import { createSlackChannel } from './slack-channel.js';
export { slackIdentity } from './slack-channel.js';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { DotAgent } from './dot-agent.js';
import { runThreadTurn } from './headless.js';
import { setupStatus, type PlatformConfig } from './platform-config.js';
import { validateRuntimeScope } from './runtime-scope.js';
import { learningSelector } from './learning.js';
export class Platform {
  private channelStartupFailed = false;
  readonly local?: LocalConversations;
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly intelligence?: CopilotKitIntelligence;
  readonly handler?: CopilotHonoApp;
  constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
  ) {
    this.computers = new ComputerService(
      workspace,
      config,
      () => store.settings().paused,
    );
    if (config.agentProvider === 'codex')
      this.local = new LocalConversations(
        workspace,
        config.conversationDatabase ?? 'data/opendots.sqlite',
      );
    this.pages = new PageService(workspace, () => {
      this.requireReady();
      return this.local
        ? {
            getOrCreateThread: async () => ({}),
            getThreadMessages: async ({ threadId }: { threadId: string }) => ({
              messages: this.local!.getThreadMessages(threadId),
            }),
          }
        : this.intelligence!;
    });
    if (this.local) {
      const runtime = new CopilotRuntime({
        runner: this.local,
        agents: async () =>
          Object.fromEntries(
            workspace
              .dots()
              .map((dot) => [
                dot.id,
                new DotAgent(store, workspace, config, dot.id),
              ]),
          ),
      });
      this.handler = createCopilotHonoHandler({
        runtime,
        basePath: '/api/copilotkit',
        cors: { origin: [] },
      });
      return;
    }
    if (!config.intelligenceKey) return;
    this.intelligence = new CopilotKitIntelligence({
      apiKey: config.intelligenceKey,
      apiUrl: config.intelligenceApiUrl,
      wsUrl: config.intelligenceWsUrl,
      getLearningContainerId: learningSelector(
        workspace,
        config.slackDotId ?? workspace.dots()[0]?.id,
      ),
    });
    const channels = [];
    if (config.slackChannel && config.slackTeam && config.slackUsers.length) {
      const dotId = config.slackDotId ?? workspace.dots()[0].id;
      if (!workspace.dot(dotId))
        throw new Error('SLACK_DOT_ID does not identify an existing Dot.');
      const slack = createSlackChannel({
        name: config.slackChannel,
        config,
        ownerId: workspace.ownerId,
        paused: () => store.settings().paused,
        agent: () => new DotAgent(store, workspace, config, dotId, true),
      });
      channels.push(slack);
    }
    const runtime = new CopilotRuntime({
      intelligence: this.intelligence,
      identifyUser: async () => ({
        id: workspace.ownerId,
        name: 'OpenDots owner',
      }),
      agents: async () =>
        Object.fromEntries(
          workspace
            .dots()
            .map((dot) => [
              dot.id,
              new DotAgent(store, workspace, config, dot.id),
            ]),
        ),
      channels,
      generateThreadNames: true,
    });
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
  }
  setup() {
    return setupStatus(
      this.config,
      this.handler?.channels?.status().overall ??
        (this.config.slackChannel ? 'setup_required' : 'not_configured'),
      this.channelStartupFailed,
    );
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(
        `Setup required: ${missing.join(', ')}. Configure the selected conversation provider.`,
      );
  }
  async start() {
    if (this.local) {
      const client = new CodexClient(
        this.config.codexBin,
        this.config.codexAuthHome,
      );
      try {
        await client.initialize();
        this.config.codexReady = true;
      } finally {
        client.close();
      }
      return;
    }
    if (this.handler?.channels) {
      try {
        await this.handler.channels.ready({ timeoutMs: 15000 });
        this.channelStartupFailed = false;
      } catch (error) {
        this.channelStartupFailed = true;
        throw error;
      }
    }
  }
  async stop() {
    await this.handler?.channels?.stop();
    if (this.local) {
      await this.local.shutdown();
    }
  }
  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found.');
    const id = randomUUID();
    if (this.local) return this.workspace.bindThread(id, dotId, title);
    try {
      await this.intelligence!.createThread({
        threadId: id,
        userId: this.workspace.ownerId,
        agentId: dotId,
        name: title,
      });
    } catch {
      throw new Error(
        'Intelligence could not create this conversation. Check the runtime key and connection.',
      );
    }
    return this.workspace.bindThread(id, dotId, title);
  }
  async history(threadId: string): Promise<string> {
    this.requireReady();
    this.workspace.requireThread(threadId);
    const history = this.local
      ? { messages: this.local.getThreadMessages(threadId) }
      : await this.intelligence!.getThreadMessages({
          threadId,
          userId: this.workspace.ownerId,
        });
    return history.messages
      .filter((message) => ['user', 'assistant'].includes(message.role))
      .slice(-12)
      .map(
        (message) =>
          `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`,
      )
      .join('\n')
      .slice(-12000);
  }
  async handle(request: Request): Promise<Response> {
    if (!this.handler)
      return Response.json(
        { error: 'Setup required: INTELLIGENCE_API_KEY.' },
        { status: 503 },
      );
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      body = await request
        .clone()
        .json()
        .catch(() => null);
    try {
      validateRuntimeScope(request, this.workspace, body);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Conversation scope denied.',
        },
        { status: 403 },
      );
    }
    return this.handler.fetch(request);
  }
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    const thread = this.workspace.requireThread(threadId);
    if (this.local) {
      const agent = new DotAgent(
        this.store,
        this.workspace,
        this.config,
        thread.dotId,
      );
      agent.threadId = threadId;
      const previous = new Set(
        this.local.getThreadMessages(threadId).map((m) => m.id),
      );
      const stop = () => {
        agent.abortRun();
      };
      signal.throwIfAborted();
      signal.addEventListener('abort', stop, { once: true });
      let error: Error | undefined;
      try {
        await lastValueFrom(
          this.local
            .run({
              threadId,
              agent,
              input: {
                threadId,
                runId: randomUUID(),
                messages: [
                  {
                    id: randomUUID(),
                    role: 'user',
                    content: prompt,
                    ...(metadata ? { metadata } : {}),
                  },
                ],
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
              },
            })
            .pipe(
              tap((event) => {
                if (event.type === 'RUN_ERROR' && 'message' in event)
                  error = new Error(String(event.message));
              }),
            ),
        );
        signal.throwIfAborted();
        return currentTurnText(
          agent.messages.filter((m) => !previous.has(m.id)),
          error,
        );
      } finally {
        signal.removeEventListener('abort', stop);
      }
    }
    return runThreadTurn(
      this.config.runtimeUrl,
      this.config.ownerToken
        ? { Authorization: `Bearer ${this.config.ownerToken}` }
        : {},
      thread.dotId,
      threadId,
      prompt,
      signal,
      metadata,
    );
  }
}
