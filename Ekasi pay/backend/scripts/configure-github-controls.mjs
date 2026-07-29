/**
 * Configure GitHub branch protection for KasiPay.
 *
 * Default policy (ALLOW_DIRECT_MAIN_PUSH=1):
 *   required CI checks + enforce_admins + linear history; force-push blocked;
 *   direct pushes to main allowed (no required PR reviews).
 *
 * Strict PR gate (ALLOW_DIRECT_MAIN_PUSH=0):
 *   also requires PR reviews + CODEOWNERS.
 *
 *   npm run github:configure-controls
 *   ALLOW_DIRECT_MAIN_PUSH=0 REQUIRED_REVIEWERS=1 npm run github:configure-controls
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

const allowDirectMainPush = !/^(0|false|no|off)$/iu.test(
  String(process.env.ALLOW_DIRECT_MAIN_PUSH ?? '1').trim(),
);

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

const protection = {
  required_status_checks: {
    strict: true,
    contexts,
  },
  enforce_admins: true,
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  block_creations: false,
  required_conversation_resolution: !allowDirectMainPush,
  lock_branch: false,
  allow_fork_syncing: false,
};

if (!allowDirectMainPush) {
  protection.required_pull_request_reviews = {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: true,
    required_approving_review_count: reviewCount,
  };
}

ghApi('PUT', `repos/${repo}/branches/main/protection`, protection);

if (allowDirectMainPush) {
  // PUT with omitted reviews can leave a prior reviews block in place on some
  // GitHub API versions — explicitly clear it.
  try {
    ghApi('DELETE', `repos/${repo}/branches/main/protection/required_pull_request_reviews`);
  } catch (error) {
    console.warn(
      'No required_pull_request_reviews to clear:',
      error instanceof Error ? error.message : error,
    );
  }
}

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
      policy: allowDirectMainPush
        ? 'direct-push-allowed-force-push-blocked'
        : 'pr-required-with-codeowners',
      enforceAdmins: true,
      allowDirectMainPush,
      requiredReviewers: allowDirectMainPush ? 0 : reviewCount,
      requireCodeOwnerReviews: !allowDirectMainPush,
      requiredChecks: contexts,
      note: allowDirectMainPush
        ? 'Direct pushes to main are allowed; force-push remains blocked. Enable Dependency graph in Settings → Code security if dependency-review still fails.'
        : 'Direct pushes to main are blocked for everyone including admins. Enable Dependency graph in Settings → Code security if dependency-review still fails.',
    },
    null,
    2,
  ),
);
