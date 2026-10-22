'use strict';
const readline = require('node:readline');
const { handle } = require('./service.cjs');
const { stopCommands } = require('./command.cjs');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopCommands(); process.exit(0); });
// Cindy loads this entry as a module; start the protocol loop on load.
const reply = message => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let request;
  try { request = JSON.parse(line); } catch { reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '无效请求' } }); return; }
  if (request.id === undefined) return;
  try { reply({ jsonrpc: '2.0', id: request.id, result: await handle(request.method, request.params || {}, request.cindy?.secrets || {}, params => reply({ jsonrpc: '2.0', method: 'fetch-progress', params })) }); }
  catch (e) { reply({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: e.message } }); }
});
