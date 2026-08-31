#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'fake-buzz-dev-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'messages_send',
    description: 'Send a test reply.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', maxLength: 1e4 },
      },
      required: ['message'],
      additionalProperties: false,
    },
  }],
}))

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
  content: [{ type: 'text', text: `sent:${params.arguments?.message ?? ''}` }],
}))

await server.connect(new StdioServerTransport())
