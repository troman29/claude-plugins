# Scout: GitHub PR workflow (30d, since 2026-10-12; run via gh as thomas5788)

## 1. Volume per repo (created in window)
| repo | total | thomas5788 | troman29 | others | merged | merged by | median open->merge (thomas) | p90 |
|---|---|---|---|---|---|---|---|---|
| windbit/agentek-console | >=300 (cap; ~309 merged) | ~274+ | 8 | mvikharev 4, vladkrakhmalev 14 | ~278 | troman29 144, vladkrakhmalev 75, mvikharev 16, thomas5788 18 (self), ASDoroshkin 8 | 0.2h | 23h |
| windbit/agentek-deploy | 157 | 154 | 2 | 1 | 92-106 | mvikharev 52, troman29 35, vladkrakhmalev 5 | 2.3h | 172h |
| windbit/delovar-ai | 42 | 41 | 1 | 0 | 40 | troman29 39, thomas5788 1 | 0.1h | 1.2h |
| windbit/ion-backend | 17 | 0 | 14 | webmakaka-ion 3 | 17 | troman29 17 | 0h (self-merge) | 24h |
| troman29/ion-wallet | 33 | 0 | 21 | webmakaka-ion 12 | 31 | troman29 20, webmakaka-ion 11 | 0.6h | 114h |
| troman29/homelab | 2 | 0 | 2 | - | 1 | troman29 | - | - |
| troman29/delovar-ai | 0 | | | | | | | |
NB: ion-backend/ion-wallet PRs are NOT by thomas5788 (Roma / webmakaka-ion), agent traffic there is ~0 in window.
Other repos with thomas5788 merged PRs (30d): agentek-hermes 33, agentek-litellm 24, agentek-lab 11, core 14, agentek-services 8, agentek-kb 6, shared-actions 5, yandex-mcp 5, + small ones. Total thomas5788 ~560 merged/30d across windbit.
Base branches (console): dev ~77%, master ~23% (releases, back-merges, hotfixes). deploy: all master. delovar-ai: main.
Reviews: console 28 reviews on 100 sampled merged PRs (approvals by vladkrakhmalev/troman29; dismissals from require_last_push_approval); 0 review threads; ~4 issue comments/100 PRs -> PR conversation is nearly empty, humans mostly just click approve+merge. ion-backend: 9 reviews, 8 threads on 1 PR.
CI failed-before-merge (console, last 60 merged thomas PRs, branch had >=1 failed pull_request run): 7/60 (~12%). Force-push (sample 20): 2 PRs, 4 events. Open PRs now with merge conflicts: 0 of 19 open. Conflicts are rare; resolution skill exists (resolving-merge-conflicts).
Self-merge: thomas5788 merged 18 console PRs itself (agent-merged, likely release/back-merge or after approval).

## 2. CI / rules / merge method
agentek-console workflows (all runs-on self-hosted `agentek`): Code quality (quality.yml, PR to master/dev; 404 runs, 20 fail=5%, avg ~3 min), Tests (tests.yml, 405 runs, 27 fail=7%, avg ~6.5 min, up to 30 min timeout, multiple jobs), build-preview (label `preview` only; 187 job-runs, 2 fail, ~1 min), build-connector-macos (4), Claude Code (claude.yml, on @claude in review comments), build-image(s), box-deploy-notify (push). Concurrency groups cancel superseded runs. Flaky: Tests > Code quality; no single named flaky job identified (did not parse per-job).
Rulesets (agentek-console): 
- "protect master & production" (org): PR required, 1 approval from team `Developers`, dismiss stale reviews on push, require_last_push_approval, require thread resolution, merge/squash/rebase allowed. (Org ruleset; is the ref include list master/production - confirm.)
- "require green CI on master" (repo, 2026-10-16): required checks "Tests passed" + "Typecheck and lint", strict (branch up to date), no deletion/non-ff. Only on master; dev has no required checks.
- "no deletion" ruleset.
Repo settings: squash+merge+rebase all allowed, allow_auto_merge=true, delete_branch_on_merge=true (console). ion-backend: auto=true, ion-wallet auto=true, deploy/delovar-ai auto=false, homelab auto=false (private, no rulesets on free plan).
Observed method (console first-parent history since 10-12): dev 349 single-parent (squash/rebase) vs 44 merge commits; master 74 single vs 32 merge. => squash default for features; merge-commit for dev<->master release and back-merge PRs (PR body says "Мержить merge commit'ом").
Other repos workflows: ion-wallet: Build web wallet, Bump PR approval, Package and publish, Test; agentek-deploy: backup-tools-build, mirror-images, sysbox-build (no PR CI checks -> merges not CI-gated); ion-backend/delovar-ai: no Actions workflows listed.
auto-merge usage so far: 0 merged PRs had autoMergeRequest set (just enabled).

## 3. Post-merge duties (AGENTS.md + docs/agents/issue-tracker.md, local ~/projects/agentek-console)
- PRs default to `dev`; master only on explicit ask. One PR per change incl. ordering deps; PRs in submodules (services/*, core/) also need issue link.
- PR body: `Closes windbit/issues#N` / `Part of windbit/issues#N` + `Requested by @login`. Cross-repo autoclose DOESN'T exist -> agent must close issue manually after merge (`gh issue close N --repo windbit/issues --comment ...`).
- AGENTS.md ~l.281: "merge to dev -> wait for rollout -> open screen on dev yourself -> close branch and issue. Everything needed on dev (roll chart, run command, recreate pods) done right now."
- Board: project 3 (windbit/Agentek) columns Inbox/In progress/...; set via gh project item-edit; issue assigned to initiator, never to thomas5788.
- Envs: dev = https://console.dev.k.agentek.ru (branch dev, ns agentek-dev), prod = master (ArgoCD), preview per-PR (label `preview`, only on request), ekomobile box manual.
- Promotion: skill `release-dev-to-master` (user-invoked): back-merge master->dev PR first (merge commit), wait for dev image bump (`ci: images -> sha [skip ci]`), then branch merge-dev-into-master, PR "Merge dev into master" with breakdown of issues/PRs; observed "chore: back-merge master into dev after release N" (#1684) and release PR #1683. Cherry-pick to master is used for hotfixes (74 single-parent on master).
- Sample of 10 recent console PR bodies: long Russian description (problem/solution/verified), screenshots, `Part of windbit/issues#N`, links to sibling PRs (agentek-hermes#196), "Requested by".
- Other skills: review-pr, resolving-merge-conflicts, sprint-close, deploy-bump (bump chart tags), bump-hermes.

## 4. GitHub events relevant to shepherd + realistic monthly volume (console+deploy+delovar+hermes etc.)
- pull_request opened/closed(merged): ~560 opened, ~560 merged / mo (thomas) -> ~20/day
- pull_request_review submitted (approved/dismissed/changes_requested): console ~30-60 / 100 PRs -> ~150-250/mo; dismissed fires on every push (require_last_push_approval)
- pull_request_review_comment / issue_comment (human): very low (<20/mo)
- check_suite/workflow_run completed: console ~1000 runs/mo on PRs (~5-7% failures -> ~50-80 failures/mo); the actionable one is failure of "Tests passed"/"Typecheck and lint"
- pull_request synchronize (force-push/new commit): ~10% PRs force-push
- mergeable state change (conflict): rare, ~0-10/mo (0 open conflicting now)
- auto_merge_enabled/disabled, merge_group: none yet
- push to dev/master + `ci: images` bump commit: dev-rollout signal (deploy-to-dev-check trigger)
- issues closed in windbit/issues: manual after merge (shepherd could automate via merged PR body `Closes windbit/issues#N`)
- Approval is human-gated (Developers team, 1 approval); dominant latency is human: p90 23h in console, 172h in deploy.

## 5. Cyrus / GitHub App
- gh api repos/windbit/agentek-console/hooks -> 404 (token lacks admin), /orgs/windbit/installations -> 404, /orgs/windbit/hooks -> 404, /user/installations needs app token. CANNOT verify with thomas5788 token; no mention of Cyrus in AGENTS.md/docs/agents. Needs Roma (org admin): github.com/organizations/windbit/settings/installations. Webhooks for shepherd must be configured by an admin or use polling with thomas5788 PAT (GH_TOKEN, ghp_ classic; has project scope? unverified).
Caveats: console list capped at 300 results (real total higher); per-PR CI-failure stats sampled (60), force-push sampled (20).
