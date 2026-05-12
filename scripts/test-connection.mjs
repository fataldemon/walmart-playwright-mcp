// 简易 SSE 连通性 / 工具列表测试
// 用法: node scripts/test-connection.mjs [http://localhost:8931]

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const base = process.argv[2] || 'http://localhost:8931';
const url = new URL('/sse', base);

const transport = new SSEClientTransport(url);
const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });

await client.connect(transport);
console.log('connected to', url.href);

const tools = await client.listTools();
console.log('tools:', tools.tools.map(t => t.name));

const stats = await client.callTool({ name: 'pxvid_stats', arguments: {} });
console.log('pxvid_stats:', stats.content[0].text);

await client.close();
process.exit(0);
