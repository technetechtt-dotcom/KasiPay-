# Directory rename checklist (`Ekasi pay` → unspaced name)

**Do not rename in this release.** The nested folder `Ekasi pay/` (space in the
path) is wired into CI `working-directory`, Capacitor/Android paths, npm
workspaces, and local scripts. Rename only as a dedicated change with a green
CI branch.

## Proposed target

Pick one and stick to it (examples only):

- `ekasi-pay/`
- `EkasiPay/`

Avoid spaces and prefer lowercase for shell/CI friendliness.

## Pre-rename inventory

1. List references (repo root):

   ```bash
   rg -n "Ekasi pay" --glob '!**/node_modules/**' --glob '!**/dist/**'
   ```

2. Confirm critical consumers:

   - `.github/workflows/ci.yml` (`working-directory`, `cache-dependency-path`)
   - Root and nested `package.json` / lockfiles
   - Capacitor `android/` / future `ios/` paths
   - Any deploy manifests (Render, etc.) that `cd` into the folder
   - Local docs and developer onboarding that quote the path

3. Ensure no open PRs rely on the old path in path filters or CODEOWNERS.

## Rename steps (when scheduled)

1. Create a branch used only for the rename.
2. `git mv "Ekasi pay" <new-name>` (preserve history).
3. Update every CI `working-directory` and cache path in one commit.
4. Update README, ops-dashboard README, and backend docs that hard-code the path.
5. Update local scripts, editor tasks, and any absolute paths in personal
   notes outside the repo (out of band).
6. Run: frontend install/test/build, backend `migrate:validate` + typecheck +
   test, ops-dashboard typecheck/build, mobile verify if packaging paths moved.
7. Merge behind branch protection; notify anyone with local clones to re-clone
   or `git pull` and fix their cwd aliases.

## Risks

- Windows vs POSIX path quoting (`"Ekasi pay"` vs unquoted).
- Cached Actions dependency paths invalidating until cache keys change.
- IDE / Cursor workspace folders pointing at the old absolute path.

## Out of scope

Renaming the product display name, npm package names, or database identifiers.
Those are independent of the filesystem folder name.
