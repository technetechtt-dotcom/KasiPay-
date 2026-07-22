/**
 * Configure GitHub branch protection + staging/production environments.
 *
 * Requires: gh auth with admin scope.
 *
 *   npm run github:configure-controls
 *   REQUIRED_REVIEWERS=2 npm run github:configure-controls
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

const reviewCount = Math.min(
  2,
  Math.max(1, Number(process.env.REQUIRED_REVIEWERS?.trim() || '1') || 1),
);

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
    require_code_owner_reviews: true,
    required_approving_review_count: reviewCount,
  },
  restrictions: null,
  required_linear_history: true,
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

ghApi('PUT', `repos/${repo}/branches/main/protection`, protection);
console.log(
  `Branch protection on main: ${reviewCount} PR review(s), code owners, required checks, no force push.`,
);

try {
  ghApi('POST', `repos/${repo}/branches/main/protection/required_signatures`, {});
  console.log('Required signed commits enabled on main (where supported).');
} catch (error) {
  console.warn(
    'Signed commits not enabled (org/plan may disallow):',
    error instanceof Error ? error.message : error,
  );
}

for (const name of ['staging', 'production']) {
  try {
    ghApi('PUT', `repos/${repo}/environments/${name}`, {
      wait_timer: name === 'production' ? 0 : 0,
      reviewers: [],
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
    });
    console.log(
      `Environment "${name}" upserted (protected branches). Add required reviewers in GitHub UI.`,
    );
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
      requiredChecks: contexts,
      requiredReviewers: reviewCount,
      codeOwners: true,
      note: 'Restrict workflow edits via CODEOWNERS on .github/ and org rulesets if available.',
    },
    null,
    2,
  ),
);
