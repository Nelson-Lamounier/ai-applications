/** @format */
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { SmokeSetupError } from './types.js';

export interface PortForward { stop(): void }

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const sock = createConnection({ host: '127.0.0.1', port });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new SmokeSetupError(`port ${port} not reachable`));
        else setTimeout(tick, 500);
      });
    };
    tick();
  });
}

/** Start `kubectl -n <ns> port-forward <target> <local>:<remote>` (argv, no shell). */
export async function startPortForward(args: {
  namespace: string; target: string; localPort: number; remotePort: number;
}): Promise<PortForward> {
  const child: ChildProcess = spawn('kubectl', [
    '-n', args.namespace, 'port-forward', args.target,
    `${args.localPort}:${args.remotePort}`,
  ], { stdio: 'ignore' });
  let stopped = false;
  child.once('exit', (code) => {
    if (!stopped) console.warn(`[smoke] port-forward ${args.target} exited (${code})`);
  });
  await waitForPort(args.localPort, 20_000);
  return { stop() { stopped = true; child.kill('SIGTERM'); } };
}
