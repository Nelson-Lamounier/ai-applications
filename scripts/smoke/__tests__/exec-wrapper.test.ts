/** @format */
import { jest } from '@jest/globals';

const runCommand = jest.fn<(c: string, a: string[], o?: unknown) => Promise<{ exitCode: number; stdout: string; stderr: string }>>();
jest.mock('@repo/script-utils/exec.js', () => ({ runCommand }));

import { capture } from '../exec-wrapper';

describe('capture', () => {
  beforeEach(() => runCommand.mockReset());

  it('returns trimmed stdout on exit 0', async () => {
    runCommand.mockResolvedValueOnce({ exitCode: 0, stdout: '  hello\n', stderr: '' });
    await expect(capture('kubectl', ['version'])).resolves.toBe('hello');
  });

  it('throws SmokeSetupError with stderr on non-zero exit', async () => {
    runCommand.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'boom' });
    await expect(capture('kubectl', ['x'])).rejects.toThrow(/kubectl x.*boom/s);
  });
});
