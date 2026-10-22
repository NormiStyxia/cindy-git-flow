'use strict';
const { spawn } = require('node:child_process');
const active = new Set();
function terminate(child, signal = 'SIGTERM') {
  try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch {}
}
// Git starts transports and index-pack children. Stop the entire task on timeout/worker exit.
function stopCommands() { for (const child of active) terminate(child, 'SIGKILL'); }
process.once('exit', stopCommands);
function runCommand(command, args, options = {}) {
  const { timeout = 15000, maxBuffer = 8 * 1024 * 1024, onStderr, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...spawnOptions, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    active.add(child);
    const stdout = [], stderr = []; let size = 0, failure = null, escalation;
    const stop = error => {
      if (failure) return;
      failure = error; terminate(child);
      escalation = setTimeout(() => terminate(child, 'SIGKILL'), 1000);
    };
    const timer = setTimeout(() => stop(Object.assign(new Error('Command timed out'), { killed: true, code: 'ETIMEDOUT' })), timeout);
    const receive = (chunks, buf) => {
      size += buf.length;
      if (size > maxBuffer) { stop(Object.assign(new Error('Output too large'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })); return; }
      chunks.push(buf);
    };
    child.stdout.on('data', buf => receive(stdout, buf));
    child.stderr.on('data', buf => { receive(stderr, buf); if (!failure && onStderr) onStderr(buf); });
    child.on('error', error => { failure = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation); active.delete(child);
      // A transport could retain pipes or outlive Git; never leave that task behind.
      terminate(child, 'SIGKILL');
      const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (failure || code !== 0) reject(Object.assign(failure || new Error('Command failed'), result, { code: failure?.code ?? code, signal }));
      else resolve(result);
    });
  });
}
module.exports = { runCommand, stopCommands };
