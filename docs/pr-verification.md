# Pull request verification

Code review and manual testing are the slowest step between a change and production, and with agents writing the
code they are now most of the wait. vgate puts one verdict on every pull request (GitHub) or merge request (GitLab):
either the change merges without a person, or it asks a person one specific question. It never asks someone to read
the whole diff.

This page describes the decision. [ci.md](ci.md) sets it up on GitHub Actions and GitLab CI.

## The pipeline from pull request to production

```
pull request
 ├─ static checks     lint, types, secret scan, SAST, dependency scan        your CI, unchanged
 ├─ unit tests        the project's own                                       your CI, unchanged
 ├─ plan              vgate affected, vgate risk                              which services, how risky
 ├─ gate              vgate gate, per affected service                        does the code meet the expectations?
 ├─ guard             vgate guard, per affected or deleted service            did the change weaken the expectations?
 └─ decide            vgate decide                                            merge | needs-approval | blocked
        ├─ merge            auto-merge (or a merge queue), no person involved
        ├─ needs-approval   one approval of the named reasons, then merge
        └─ blocked          the author (person or agent) fixes the change
merge → deploy
        ├─ smoke              vgate smoke, against the deployed environment       read-only, writes refused
        └─ canary             vgate canary, while the new version takes traffic   breach -> rollback, once
```

After the merge, `vgate smoke` and `vgate canary` verify the deployed version: [after-deploy.md](after-deploy.md).

vgate does not replace the static checks and unit tests a team already runs: keep them as required checks next to
vgate's `verdict`. It replaces the two human steps: reading the code to see whether it does what it should, and
clicking through the service to see whether it still works.

## The decision

`vgate decide --base <merge base> --evidence <dir>` reads every `verdict.json` (from `vgate gate`) and `guard.json`
(from `vgate guard`) under the evidence directory and decides:

| Decision         | When                                                                                                                                           | What happens                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `blocked`        | an affected service's gate failed, or its verdict is missing, partial or stale                                                                 | the check fails; the author fixes the change                   |
| `needs-approval` | every gate passed, but a guard said `needs-human` or did not run, a service was deleted, or the change's risk tier is above `policy.autoMerge` | the check waits for one approval of the reasons listed         |
| `merge`          | every affected service's gate passed, every guard said `auto`, and the risk tier is within `policy.autoMerge`                                  | the check passes; with auto-merge on, the change merges itself |

`decide` recomputes which services the change affects instead of trusting the jobs that ran, so a job that was
skipped, cancelled or never configured is missing evidence, and missing evidence blocks. The decision fails closed.
Evidence is also bound to what it judged: a verdict or guard report names the commit and the uncommitted state it ran
on, and one from another commit (an earlier push, another branch) or from a tree edited after it ran counts as
missing. A verdict from outside git falls back to the hashes of the contract, plan and `service.yaml` it was computed
against, and the decision says so.

It writes `reports/decision.json` (for machines and audits) and `reports/decision.md`: the pull request comment, one
per pull request, updated in place on every push. The comment states the decision, the reasons, each service's gate
result (tests, failed scenarios, coverage), the guard's findings in plain words, the risk matches, the known failures
tolerated, and a link to the full reports.

A change that touches no service (documentation, a README) has nothing to prove: its decision depends on its risk
tier alone.

### Safe to deploy

With a `deploy:` block in `vgate.yaml`, the decision also asks whether the change is safe to put next to what runs in
each environment: does its contract still serve the clients of the version deployed there (`vgate compat`), and does
each environment provide every setting the code requires (`vgate config-check`)? A change that breaks the deployed
contract needs an approval (or is blocked, with `deploy.policy.breaking: block`); a required setting an environment
lacks blocks the change, because deploying it would fail; a deployed contract or config file that cannot be read needs
an approval, never passes. Without `deploy:`, the comment says deploy safety was not checked.
[deploy-safety.md](deploy-safety.md) has the configuration.

## Policy and risk

Both live in `vgate.yaml`, which is itself a judge's file: changing it is a `needs-approval` change.

```yaml
version: 0.2.0
servicesDir: regression
policy:
  # The highest risk tier that may merge without a person: none | low | medium | high.
  autoMerge: low
risk:
  high:
    - path: '**/migrations/**'
      reason: schema change
    - path: 'internal/billing/**'
      reason: money
  medium:
    - path: 'internal/**'
# Every changed file matching no rule is low.
```

Each changed file takes the tier of the first rule that matches it, in the order written (low when none does), and
the change takes the highest tier of its files. Without a `risk:` block vgate uses built-in rules that fit most
stacks without configuration: database migrations, authentication and authorization code, money (payments, billing,
wallets, ledgers), secrets and infrastructure are high; dependencies, container builds and API contracts are medium;
documentation is low. A `risk:` block replaces the built-in rules. The judge's own files (`vgate.yaml`,
`known-failures.yaml`, CI workflows, CODEOWNERS) are always high, whatever the project's rules say, and a change to
them is `needs-approval` even under `autoMerge: high`.
`vgate risk --base <ref>` shows which file matched which rule.

Which services a change affects comes from each service's `service.yaml`:

```yaml
# regression/orders/service.yaml
paths:
  - services/orders/**
  - libs/money/**
```

A service without `paths` is affected by any change outside the other services' directories. A change to the
service's own directory (`regression/orders/**`: its tests, contract, plan) always affects it, and a service the change
deletes is guarded against the base. Narrowing `paths` (a glob removed, or a list added where there was none) would let
later changes skip the service's gate, so the guard flags it (`config-loosened`) and a person approves it. A submodule
counts as its directory: a bump of `libs/shared` matches `libs/shared/**`.

### Examples

**A monorepo with two services.** Each `service.yaml` names its source directories and the shared libraries it uses.
A pull request that changes only `services/orders/**` gates and guards `orders` alone; one that changes a shared
library gates both. CI time grows with what changed, not with the size of the repository.

```yaml
# regression/orders/service.yaml        # regression/payments/service.yaml
paths: [services/orders/**, libs/**]     paths: [services/payments/**, libs/**]
```

**A typical web backend.** One service, `autoMerge: low`, the built-in rules. Most changes (handlers, queries,
refactors) merge on a green gate. A migration or a change to how users log in waits for one
person to read the comment and approve.

**A regulated team** (banking, health, anything with change-management rules that require a named approver).
`autoMerge: none`. Every change ends in `needs-approval`, but the approver reads a two-minute comment instead of
re-testing: what the change does to the API, which scenarios ran and passed, what the guard flagged, which files were
risky. `reports/decision.json` and the approval in the platform's audit log are the evidence a change-management
review asks for.

## What a person reviews

Each `needs-approval` reason is a specific question, and the comment names it:

| Reason                      | The question                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| a service was deleted       | Is it intended that this service, and every expectation about it, is gone?                         |
| the guard did not run       | Why is there no guard result? (Re-run the job; approve only if the change is clearly harmless.)    |
| guard `contract-breaking`   | Is it intended that clients see this change (a removed field, a response, a newly required input)? |
| guard `plan-weakened`       | Is this scenario no longer a requirement? (Removed from the plan, or newly excluded.)              |
| guard `tests-weakened`      | Why does this test check less than before?                                                         |
| guard `config-loosened`     | Is it right that the gate checks this less strictly from now on (or, for `paths`, less often)?     |
| guard `known-failure-added` | Should the gate tolerate this failure until the date given, under this ticket?                     |
| guard `machinery-changed`   | Is this change to the judge itself (vgate.yaml, the workflow, the configs) intended?               |
| risk tier above policy      | This change is in a risky area: do the passing scenarios cover what worries you here?              |

The reviewer approves in the platform (GitHub: the protected environment `vgate-expectations`; GitLab: an approval
of the merge request by an eligible approver), and the check passes. A new push needs a new approval.

## Merge queues

On GitHub, `merge_group` runs judge the queued merge (the pull request on top of the latest default branch) against
the queue's base. A change whose decision is `merge` passes through the queue unattended. An environment approval
belongs to one run, so a `needs-approval` change asks its reviewer again in the queue; teams with many such changes
approve before queueing and keep the queue for `merge` decisions.

## Pull requests from forks

GitHub gives a pull request from a fork a read-only token. The gate, the guard and the decision run as usual and the
`verdict` check reports the result, but the comment and auto-merge steps skip with a notice (the decision is in the
job summary). The workflow never uses `pull_request_target`, which would run the fork's code with write access.

## Adopting it

1. **Shadow mode, two weeks.** Install the workflow with `VGATE_AUTOMERGE: 'false'` and do not make `verdict`
   required. Keep reviewing as before, and compare each pull request's vgate decision with what the human review
   concluded. Every change a person rejected that vgate decided `merge` is a missing scenario or a missing risk rule:
   add it.
2. **Required check.** Make `verdict` required on the default branch. People still review, but only the
   `needs-approval` changes, and only the reasons listed.
3. **Auto-merge.** Set `policy.autoMerge` (start at `low`) and `VGATE_AUTOMERGE: 'true'`. Watch escaped defects
   (bugs found after deploy) per release; if they rise, lower the policy and add the scenarios that would have caught
   them.

What to measure throughout: escaped defects, the time from opening a pull request to merging it, the person-minutes
spent per pull request, and the share of pull requests decided `merge`.

## Limits

- vgate verifies the service against its spec. Whether the spec says the right thing is a person's call, which is why
  every change to the expectations asks one.
- The decision covers the services vgate knows. Code outside any service's `paths` (a frontend, a CLI, scripts) is
  judged only by its risk tier and your other checks.
- A green gate means the scenarios passed. Coverage shows which documented responses they reach; how strong they are
  shows in the mutation score (below), when the project measures it.

## Test strength

Coverage shows a line ran; it cannot show a test would notice the line going wrong. With `policy.mutationScore` in
vgate.yaml, the gate job also runs `vgate mutate --service <s> --base <base>`. It plants small bugs in the lines the pull
request changed, reruns the service's tests against each, and scores how many they catch. `decide` reads the
evidence:

- below the threshold, unmeasured or missing evidence → **needs-approval**, with each surviving bug and the scenario
  that would catch it in the comment;
- never blocked: it measures the tests, not the code.

See [mutation.md](mutation.md).
