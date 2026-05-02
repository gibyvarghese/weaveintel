/**
 * Build + push a diagnostic kernel that introspects what's available
 * for orbit_wars. We need to find the right way to invoke matches.
 */
import { liveKaggleAdapter } from '@weaveintel/tools-kaggle';

const SCRIPT = `
import os, sys, traceback, json
from kaggle_environments import make, registry, evaluate

print('=== registry keys ===')
try:
    print(sorted(registry.keys()))
except Exception as e:
    print('registry err:', e)

print('=== try make(orbit_wars) ===')
try:
    env = make('orbit_wars', debug=False)
    print('OK env:', type(env).__name__, 'name:', env.name)
except Exception as e:
    print('make err:', e)

print('=== try make(orbit-wars) ===')
try:
    env = make('orbit-wars', debug=False)
    print('OK env:', type(env).__name__)
except Exception as e:
    print('make err:', e)

print('=== competition input dir ===')
indir = '/kaggle/input/competitions/orbit-wars'
if os.path.isdir(indir):
    print(os.listdir(indir))
else:
    print('not present')

print('=== look for env in installed kaggle_environments ===')
import kaggle_environments
print('ke version:', kaggle_environments.version)
ke_dir = os.path.dirname(kaggle_environments.__file__)
envs_dir = os.path.join(ke_dir, 'envs')
print('envs dir:', envs_dir)
print('contents:', sorted(os.listdir(envs_dir))[:50])
print('orbit_wars present:', 'orbit_wars' in os.listdir(envs_dir))

print('=== try import orbit_wars module ===')
try:
    from kaggle_environments.envs.orbit_wars import orbit_wars as ow_mod
    print('OK module:', ow_mod.__file__)
    print('attrs:', [a for a in dir(ow_mod) if not a.startswith('_')][:30])
except Exception as e:
    print('import err:', e)
    traceback.print_exc()

print('=== try evaluate ===')
def random_agent(obs):
    return []
try:
    rewards = evaluate('orbit_wars', [random_agent, random_agent], num_episodes=1)
    print('OK rewards:', rewards)
except Exception as e:
    print('evaluate err:', e)
`;

async function main() {
  const creds = { username: process.env['KAGGLE_USERNAME']!, key: process.env['KAGGLE_KEY']! };
  const slug = `${creds.username}/orbit-wars-diag`;
  console.log('Pushing diagnostic kernel...');
  const push = await liveKaggleAdapter.pushKernel(creds, {
    slug,
    title: 'Orbit Wars diagnostic',
    source: SCRIPT,
    kernelType: 'script',
    language: 'python',
    isPrivate: true,
    competitionSource: 'orbit-wars',
    enableInternet: false,
    enableGpu: false,
  });
  console.log('Pushed:', push.url);
  const m = (push.url || '').match(/code\/([^/]+)\/([^/?#]+)/);
  const ref = m ? `${m[1]}/${m[2]}` : push.ref;
  console.log('Polling', ref);
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20_000));
    try {
      const out = await liveKaggleAdapter.getKernelOutput(creds, ref);
      const log = out.log ?? '';
      const done = log.includes('=== try evaluate ===') && (log.includes('OK rewards') || log.includes('evaluate err'));
      console.log(`log=${log.length}b done=${done}`);
      if (done) {
        console.log('--- TAIL ---');
        console.log(log.slice(-3500));
        return;
      }
    } catch (e) {
      console.log('err:', (e as Error).message.slice(0, 100));
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
