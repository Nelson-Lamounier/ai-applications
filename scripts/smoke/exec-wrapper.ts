/** @format */
import { runCommand } from '@repo/script-utils/exec.js';
import { SmokeSetupError } from './types.js';

/** Run a command via argv array (no shell). Returns trimmed stdout.
 *  Throws SmokeSetupError (command + stderr) on non-zero exit. */
export async function capture(
  cmd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<string> {
  const res = await runCommand(cmd, args, { captureOutput: true, ...opts });
  if (res.exitCode !== 0) {
    throw new SmokeSetupError(`\`${cmd} ${args.join(' ')}\` failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }
  return res.stdout.trim();
}
