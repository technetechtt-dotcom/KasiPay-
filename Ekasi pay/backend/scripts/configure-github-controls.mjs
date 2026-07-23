/**
 * Configure GitHub branch protection for KasiPay.
 *
 * Requires PR + CODEOWNERS for financial/security paths, required CI checks,
 * and enforce_admins. Direct pushes to main are blocked.
 *
 *   npm run github:configure-controls
 *   REQUIRED_REVIEWERS=1 npm run github:configure-controls
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
  return result.stdout?.trim() ? JSON.parse(result.stdout) : null;
}

console.log(`Configuring protected main for ${repo}…`);

ghApi('PUT', `repos/${repo}/branches/main/protection`, {
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
});

// Enable Dependency graph / Dependabot surfaces where the API allows.
for (const path of [
  `repos/${repo}/vulnerability-alerts`,
  `repos/${repo}/automated-security-fixes`,
]) {
  try {
    ghApi('PUT', path);
    console.log(`Enabled ${path}`);
  } catch (error) {
    console.warn(
      `Could not enable ${path}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

for (const name of ['staging', 'production']) {
  try {
    ghApi('PUT', `repos/${repo}/environments/${name}`, {
      wait_timer: name === 'production' ? 5 : 0,
      reviewers: [],
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
    });
    console.log(
      `Environment "${name}" upserted — add required reviewers in GitHub UI.`,
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
      policy: 'pr-required-with-codeowners',
      enforceAdmins: true,
      requiredReviewers: reviewCount,
      requireCodeOwnerReviews: true,
      requiredChecks: contexts,
      note: 'Direct pushes to main are blocked for everyone including admins. Enable Dependency graph in Settings → Code security if dependency-review still fails.',
    },
    null,
    2,
  ),
);
