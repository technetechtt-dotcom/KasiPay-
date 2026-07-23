/**
 * Configure lightweight GitHub controls for direct pushes to main.
 *
 * Preference: push straight to main — do not require pull requests.
 *
 *   npm run github:configure-controls
 */
import { spawnSync } from 'node:child_process';

const repo =
  process.env.GITHUB_REPO?.trim() ||
  spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    encoding: 'utf8',
  }).stdout.trim();

if (!repo) {
  throw new Error('Could not resolve GITHUB_REPO. Pass GITHUB_REPO=owner/name.');
}

function ghApi(method, path, body) {
  const args = ['api', '-X', method, path];
  if (body !== undefined) args.push('--input', '-');
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    input: body !== undefined ? JSON.stringify(body) : '',
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `gh api ${method} ${path} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout ? JSON.parse(result.stdout) : null;
}

console.log(`Configuring controls for ${repo} (direct pushes to main)…`);

// Keep force-push / deletion blocked, but allow direct pushes without PR/sign-off gates.
ghApi('PUT', `repos/${repo}/branches/main/protection`, {
  required_status_checks: null,
  enforce_admins: false,
  required_pull_request_reviews: null,
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
  block_creations: false,
  required_conversation_resolution: false,
  lock_branch: false,
  allow_fork_syncing: false,
});

try {
  ghApi('DELETE', `repos/${repo}/branches/main/protection/required_signatures`);
} catch {
  // Already unset.
}

for (const name of ['staging', 'production']) {
  try {
    ghApi('PUT', `repos/${repo}/environments/${name}`, {
      wait_timer: 0,
      reviewers: [],
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
    });
    console.log(`Environment "${name}" upserted.`);
  } catch (error) {
    console.warn(
      `Environment ${name}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      repo,
      policy: 'direct-push-to-main',
      note: 'PRs are optional. Force pushes and branch deletion remain blocked.',
    },
    null,
    2,
  ),
);
