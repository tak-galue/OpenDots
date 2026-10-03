#!/usr/bin/env node
// Protocol fixture: no provider calls, credentials or host file access.
import process from 'node:process';
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const event = (method, params) => send({ method, params });
let mode = '';
const text = (value) => {
  event('item/agentMessage/delta', { itemId: 'reply', delta: value });
  event('item/completed', {
    item: { type: 'agentMessage', id: 'reply', text: value },
  });
  event('turn/completed', { turn: { status: 'completed' } });
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (!method) {
    if (id === 'native')
      text(message.error ? 'native denied' : 'native approved');
    else if (id === 'tool')
      text(message.result.success ? 'tool succeeded' : 'tool rejected');
    return;
  }
  if (method === 'initialized') return;
  if (method === 'initialize') send({ id, result: {} });
  else if (method === 'account/read')
    send({ id, result: { account: { type: 'chatgpt' } } });
  else if (method === 'thread/start') {
    if (
      params.config ||
      !params.ephemeral ||
      params.approvalPolicy !== 'never' ||
      params.sandbox !== 'read-only'
    ) {
      send({ id, error: { message: 'Unsafe thread settings' } });
      return;
    }
    send({ id, result: { thread: { id: 'fixture-thread' } } });
  } else if (method === 'turn/start') {
    mode = JSON.parse(params.input[0].text).at(-1).content;
    send({ id, result: { turn: { id: 'fixture-turn' } } });
    if (mode === 'hang') return;
    if (mode === 'native')
      send({
        id: 'native',
        method: 'item/commandExecution/requestApproval',
        params: {},
      });
    else if (mode === 'tool' || mode === 'invalid' || mode === 'review') {
      send({
        id: 'tool',
        method: 'item/tool/call',
        params: {
          tool: mode === 'review' ? 'review_space_page' : 'echo_tool',
          callId: 'call-fixture',
          arguments:
            mode === 'review'
              ? { title: 'Draft', content: 'Draft content', spaceId: 'space' }
              : { value: mode === 'invalid' ? 42 : 'hello' },
        },
      });
    } else if (mode === 'crash') process.exit(1);
    else if (mode === 'fail')
      event('turn/completed', {
        turn: { status: 'failed', error: { message: 'fixture failure' } },
      });
    else text('fixture answer');
  }
});
