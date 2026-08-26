#!/usr/bin/env node
/**
 * Create an rc-* tag only when GitHub Actions validate succeeded for HEAD.
 * Never tags a failed SHA. Does not deploy.
 *
 *   node scripts/release-candidate.mjs
 */
import { spawnSync } from 'node:child_process';

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${cmd} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  }
  return (result.stdout || '').trim();
}

const sha = run('git', ['rev-parse', 'HEAD']);
const short = sha.slice(0, 12);
const conclusion = run('gh', [
  'run',
  'list',
  '--commit',
  sha,
  '--workflow',
  'CI',
  '--json',
  'conclusion,status,databaseId,url',
  '-q',
  '.[0]',
]);
if (!conclusion) {
  throw new Error(`No CI run found for ${short}. Push to origin/main and wait for validate.`);
}
const runInfo = JSON.parse(conclusion);
if (runInfo.status !== 'completed' || runInfo.conclusion !== 'success') {
  throw new Error(
    `CI is ${runInfo.status}/${runInfo.conclusion} for ${short}. Refusing to tag. ${runInfo.url ?? ''}`,
  );
}

const day = new Date().toISOString().slice(0, 10);
const tag = `rc-${day}-${short}`;
const existing = spawnSync('git', ['rev-parse', tag], { encoding: 'utf8' });
if ((existing.status ?? 1) === 0) {
  console.log(`Tag ${tag} already exists.`);
  process.exit(0);
}
run('git', ['tag', '-a', tag, '-m', `Release candidate ${tag} after green CI ${runInfo.databaseId}`]);
run('git', ['push', 'origin', tag]);
console.log(`Tagged and pushed ${tag} for ${short}.`);
