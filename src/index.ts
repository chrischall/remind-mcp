#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { RemindClient } from './client.js';
import { registerAccountTools } from './tools/account.js';
import { registerChatTools } from './tools/chats.js';
import { registerClassTools } from './tools/classes.js';
import { registerRawTools } from './tools/raw.js';
import { VERSION } from './version.js';

// Built in the caller so the server still boots (and answers a host's
// install-time tools/list probe) with no session captured yet — the
// bootstrap error surfaces on the first tool call instead.
const client = new RemindClient();

await runMcp({
  name: 'remind-mcp',
  version: VERSION,
  banner: '[remind-mcp] This project was developed and is maintained by AI. Use at your own discretion.',
  deps: client,
  tools: [registerAccountTools, registerClassTools, registerChatTools, registerRawTools],
});
