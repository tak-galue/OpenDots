import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { lastValueFrom, toArray } from 'rxjs';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { codexRun } from '../src/server/codex-agent.js';
import { pageReviewTool } from '../src/shared/page-review.js';
import { setupStatus } from '../src/server/platform-config.js';
const config = {
  agentProvider: 'codex' as const,
  codexBin: resolve('tests/fixtures/codex-server.mjs'),
  codexAuthHome: '/nonexistent',
  baseUrl: '',
  runtimeUrl: '',
  slackUsers: [],
  voiceName: 'marin',
};
async function run(content: string, signal = AbortSignal.timeout(5000)) {
  let executions = 0;
  const events = await lastValueFrom(
    codexRun(
      config,
      {
        threadId: 'thread',
        runId: 'run',
        messages: [{ id: 'user', role: 'user', content }],
        state: {},
        tools: [pageReviewTool],
        context: [],
        forwardedProps: {},
      },
      'Dot role',
      [
        defineTool({
          name: 'echo_tool',
          description: 'Echo',
          parameters: z.object({ value: z.string() }),
          execute: async (args) => {
            executions++;
            return args;
          },
        }),
      ],
      signal,
      () => signal.throwIfAborted(),
    ).pipe(toArray()),
  );
  return { events, executions };
}
describe('Codex protocol adapter', () => {
  it('streams an actual protocol response with one text start/end', async () => {
    const { events } = await run('hello');
    expect(
      events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT'),
    ).toMatchObject([{ delta: 'fixture answer' }]);
    expect(events.filter((e) => e.type === 'TEXT_MESSAGE_START')).toHaveLength(
      1,
    );
    expect(events.filter((e) => e.type === 'TEXT_MESSAGE_END')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
  });
  it('executes validated server tools and returns their output to Codex', async () => {
    const { events, executions } = await run('tool');
    expect(executions).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TOOL_CALL_RESULT',
        content: '{"value":"hello"}',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ delta: 'tool succeeded' }),
    );
  });
  it('rejects invalid arguments without executing tools', async () => {
    const { events, executions } = await run('invalid');
    expect(executions).toBe(0);
    expect(events.at(-1)?.type).toBe('RUN_ERROR');
  });
  it('returns review control to the browser without creating a page', async () => {
    const { events, executions } = await run('review');
    expect(executions).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TOOL_CALL_START',
        toolCallName: 'review_space_page',
      }),
    );
    expect(events.some((e) => e.type === 'TOOL_CALL_RESULT')).toBe(false);
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
  });
  it('denies native approvals', async () => {
    const { events } = await run('native');
    expect(events).toContainEqual(
      expect.objectContaining({ delta: 'native denied' }),
    );
  });
  it('reports provider failure and process exits as run errors', async () => {
    for (const mode of ['fail', 'crash'])
      expect((await run(mode)).events.at(-1)?.type).toBe('RUN_ERROR');
  });
  it('terminates a hanging turn when cancelled', async () => {
    const { events } = await run('hang', AbortSignal.timeout(300));
    expect(events.at(-1)).toMatchObject({
      type: 'RUN_ERROR',
      message: 'Codex turn was stopped.',
    });
  });
  it('requires Codex login instead of cloud/model keys, with explicit unavailable channels', () => {
    expect(setupStatus({ ...config, codexReady: true })).toMatchObject({
      provider: 'codex',
      model: true,
      intelligence: false,
      missing: [],
      slack: 'unavailable_in_codex_mode',
    });
    expect(setupStatus(config).missing).toEqual(['CODEX_LOGIN']);
  });
});

it('runs scheduled/page conversation turns with local history and saves transcripts', async () => {
  const { Platform } = await import('../src/server/platform.js');
  const { Store } = await import('../src/server/store.js');
  const { WorkspaceStore } = await import('../src/server/workspace.js');
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const platform = new Platform(store, workspace, {
    ...config,
    conversationDatabase: ':memory:',
  });
  try {
    await platform.start();
    const dot = workspace.dots()[0];
    const thread = await platform.createConversation(
      dot.id,
      'Local conversation',
    );
    expect(
      await platform.turn(thread.id, 'hello', AbortSignal.timeout(5000)),
    ).toBe('fixture answer');
    expect(await platform.history(thread.id)).toContain(
      'assistant: fixture answer',
    );
    const page = await platform.pages.saveConversation(
      thread.id,
      'Transcript',
      null,
    );
    expect(page.content).toContain('fixture answer');
    const pageThread = await platform.pages.conversation(
      page.spaceId,
      page.id,
      dot.id,
    );
    expect(
      await platform.turn(pageThread.id, 'hello', AbortSignal.timeout(5000)),
    ).toBe('fixture answer');
    store.updateSettings({ paused: true });
    await expect(
      platform.turn(thread.id, 'hello', AbortSignal.timeout(5000)),
    ).rejects.toThrow();
  } finally {
    await platform.stop();
    store.close();
    workspace.close();
  }
});
