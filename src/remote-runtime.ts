import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { isValidProfileName } from './util.ts';

export interface Profile {
  owner: string;
  name: string;
  apiSecret?: string;
  mock?: boolean;
}

const run = promisify(execFile);
const image = 'localhost/multiclaude-worker:1';
const mockImage = 'localhost/multiclaude-worker-mock:1';

function prefix(p: Profile): string {
  const scope = createHash('sha256').update(JSON.stringify([p.owner, p.name])).digest('hex');
  return 'mc-' + scope + '-';
}

export function containerArgs(p: Profile): string[] {
  if (![p.owner, p.name].every(isValidProfileName) || (p.apiSecret !== undefined && !isValidProfileName(p.apiSecret))) {
    throw new Error('Invalid worker profile');
  }
  return ['--rm', '--pull=never', '--user', '1000:1000', '--cap-drop=all',
    '--security-opt=no-new-privileges', '--log-driver=none', '--http-proxy=false',
    '--volume', prefix(p) + 'home:/home/worker:U', '--env', 'HOME=/home/worker',
    ...(p.mock ? ['--network=none'] : []),
    ...(p.apiSecret ? ['--secret', p.apiSecret + ',type=env,target=ANTHROPIC_API_KEY'] : [])];
}

export const runtime = {
  async list(p: Profile) {
    const { stdout } = await run('podman', ['ps', '--filter', 'name=^' + prefix(p), '--format', '{{.Names}}']);
    return stdout.trim().split(/\s+/).filter(n => n.startsWith(prefix(p))).map(n => n.slice(prefix(p).length));
  },
  async start(p: Profile, id: string) {
    await run('podman', ['run', '-d', ...containerArgs(p), '--timeout', '86400', '--pids-limit', '512',
      '--name', prefix(p) + id, p.mock ? mockImage : image, 'serve']);
  },
  attach(p: Profile, id: string) {
    return spawn('podman', ['exec', '-i', prefix(p) + id, 'python3', '-I', '/opt/mc/worker.py', 'attach'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
  },
  async end(p: Profile, id: string) {
    await run('podman', ['rm', '--force', '--ignore', prefix(p) + id]);
  },
};

export async function requireRootless() {
  if (process.platform !== 'linux' || process.getuid?.() === 0) throw new Error('Use a dedicated non-root Linux account.');
  const { stdout } = await run('podman', ['info', '--format', '{{.Host.Security.Rootless}}']);
  if (stdout.trim() !== 'true') throw new Error('Remote hosting requires rootless Podman.');
}

export function provision(p: Profile) {
  const result = spawnSync('podman', ['run', '-it', ...containerArgs(p), image, 'login'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Worker sign-in failed.');
}
