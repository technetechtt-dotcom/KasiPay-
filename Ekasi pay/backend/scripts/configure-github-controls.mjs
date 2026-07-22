/**
 * Configure GitHub branch protection + production environment approvals.
 *
 * Requires: gh auth with admin:repo_hook / repo administration scope.
 *
 *   npm run github:configure-controls
 *   GITHUB_REPO=owner/name npm run github:configure-controls
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

const contexts = [
  'github-controls-reminder',
  'secret-scan',
  'codeql',
  'sbom',
  'validate',
  'mobile-web-build',
  'mobile-ios-verify',
  'ops-dashboard',
];

const protection = {
  required_status_checks: {
    strict: true,
    contexts,
  },
  enforce_admins: true,
  required_pull_request_reviews: {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: false,
    required_approving_review_count: 1,
  },
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
  block_creations: false,
  required_conversation_resolution: true,
  lock_branch: false,
  allow_fork_syncing: false,
};

function ghApi(method, path, body) {
  const args = ['api', '-X', method, path, '--input', '-'];
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    input: body ? JSON.stringify(body) : '',
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `gh api ${method} ${path} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout ? JSON.parse(result.stdout) : null;
}

console.log(`Configuring controls for ${repo}…`);

ghApi(
  'PUT',
  `repos/${repo}/branches/main/protection`,
  protection,
);
console.log('Branch protection on main: required checks + PR review + no force push.');

try {
  ghApi('PUT', `repos/${repo}/environments/production`, {
    wait_timer: 0,
    reviewers: [],
    deployment_branch_policy: {
      protected_branches: true,
      custom_branch_policies: false,
    },
  });
  console.log(
    'Environment "production" created/updated (protected branches only). Add required reviewers in the GitHub UI.',
  );
} catch (error) {
  console.warn(
    String(error instanceof Error ? error.message : error),
  );
  console.warn(
    'If environments API is unavailable on this plan, create Environment "production" with required reviewers in Settings → Environments.',
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      repo,
      requiredChecks: contexts,
      note: 'dependency-review remains PR-only and is not listed as a push required check.',
    },
    null,
    2,
  ),
);
