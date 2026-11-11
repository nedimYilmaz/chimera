#!/usr/bin/env node
// Raw JSON-RPC keeps the compatibility test independent of the SDK under test.
import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const sessionId = 'sdk-wire-session';
let promptId;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === 'permission') {
    send({ id: promptId, result: { stopReason: message.result?.outcome?.optionId === 'allow' ? 'end_turn' : 'refusal' } });
    continue;
  }
  if (message.method === 'session/cancel') {
    send({ id: promptId, result: { stopReason: 'cancelled' } });
    continue;
  }
  if (message.method === 'session/prompt') {
    promptId = message.id;
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'received' } } } });
    if (message.params.prompt[0].text === 'wait') continue;
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'compaction_update', compactionId: 'compact-1', status: 'completed' } } });
    send({ id: 'permission', method: 'session/request_permission', params: {
      sessionId, toolCall: { toolCallId: 'tool-1', title: 'Read fixture', kind: 'read' },
      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
    } });
    continue;
  }
  let result = {};
  if (message.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
  if (message.method === 'session/new') result = { sessionId, configOptions: [{
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'kimi-wire-model',
    options: [{ value: 'kimi-wire-model', name: 'Wire model' }],
  }] };
  send({ id: message.id, result });
}
