# vgate in CI

Every pull request (GitHub) or merge request (GitLab) gets one vgate decision: `merge`, `needs-approval` or
`blocked`. What the decision means and how to tune it: [pr-verification.md](pr-verification.md). This page sets it up.

Everything runs the vgate version pinned in `vgate.yaml`, installed from the release (GitHub) or from the pinned image
(GitLab), never from the pull request's checkout, and no report the checkout carries is ever read as evidence. Every
change to the judge's own files (`vgate.yaml` with its pin, the CI files, `known-failures.yaml`) is a
`needs-approval` change. That decision cannot be the only lock: a pull request runs its own copy of the workflow and
installs the version its own `vgate.yaml` pins, so a changed judge could pass itself. CODEOWNERS with a required code
owner review (step 5) is what stops that.

## GitHub Actions

`vgate init --ci github` copies `ci/github/vgate.yml` to `.github/workflows/vgate.yml`, and
`ci/github/CODEOWNERS.example` to `.github/CODEOWNERS.vgate.example`.

| Job         | When                                                                 | Does                                                                                                  |
| ----------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `plan`      | always                                                               | the pinned version, the merge base, `vgate affected` (which services), `vgate risk` (how risky)       |
| `gate`      | per affected service (every service on a push to the default branch) | `doctor --fix`, `up`, `gate`, `down`; the verdict as evidence, the full reports as an artifact        |
| `guard`     | pull requests and merge queues, per affected or deleted service      | `vgate guard` against the merge base; its result as evidence                                          |
| `decide`    | pull requests and merge queues, always                               | `vgate decide` over all evidence; one sticky comment on the pull request; the decision in the summary |
| `approval`  | only on `needs-approval`                                             | waits in the protected environment `vgate-expectations` for a required reviewer                       |
| `verdict`   | always                                                               | **the check to require**: passes on `merge`, or on `needs-approval` once approved                     |
| `automerge` | pull requests from the same repository                               | on `merge` with `VGATE_AUTOMERGE: 'true'`, turns on GitHub auto-merge; otherwise turns it off         |

Settings in the workflow's `env`:

| Variable             | Default   | Meaning                                                                       |
| -------------------- | --------- | ----------------------------------------------------------------------------- |
| `VGATE_PROJECT_DIR`  | `.`       | Where `vgate.yaml` sits, relative to the repository root                      |
| `VGATE_REPORTS_DIR`  | `reports` | The project's `reportsDir`                                                    |
| `VGATE_AUTOMERGE`    | `false`   | Auto-merge pull requests decided `merge` (start in shadow mode: leave it off) |
| `VGATE_MERGE_METHOD` | `squash`  | `merge`, `squash` or `rebase`                                                 |

Set it up once per repository:

1. **Environment.** Settings > Environments > New environment `vgate-expectations`. Add the required reviewers
   (people or a team, not the bot that opens pull requests) and tick "Prevent self-review". An approval covers one
   run, so every new push needs a new one. Without required reviewers (the environment was never created, or the
   plan offers none for private repositories) GitHub starts the job at once; the `approval` job then finds no recorded
   approval and fails, so `needs-approval` can never pass unreviewed.
2. **Branch protection** (or a ruleset) on the default branch: require pull requests and the status check
   `verdict`. Keep your other required checks (lint, unit tests) next to it.
3. **Auto-merge** (when you turn on `VGATE_AUTOMERGE`): Settings > General > "Allow auto-merge". GitHub then merges as
   soon as every required check passes. A merge made with the workflow's own token starts no further workflow runs;
   if a deploy or release workflow runs on pushes to the default branch, store a GitHub App or fine-grained token
   (contents and pull requests: write) as the secret `VGATE_MERGE_TOKEN`.
4. **Merge queue** (optional): require `verdict` in the queue too. The workflow runs on `merge_group` and judges the
   queued merge against the queue's base.
5. **CODEOWNERS.** Merge `.github/CODEOWNERS.vgate.example` into `.github/CODEOWNERS`, replace the placeholder team,
   and turn on "Require review from Code Owners". A pull request runs its own copy of the workflow (and can add new
   workflows that report a check named `verdict`), so every workflow, `vgate.yaml` and every `known-failures.yaml`
   need an owner's review before the checks they produce can be trusted. Without this, a pull request that edits the
   workflow can make `verdict` pass whatever vgate decides.

Permissions are per job and minimal: `contents: read` everywhere, `pull-requests: write` only for the comment,
`actions: read` only for the approval check, `contents: write` only for auto-merge. The workflow runs on `pull_request`, never `pull_request_target`; a pull
request from a fork gets a read-only token, so its comment and auto-merge steps skip with a notice while the gate,
guard, decision and `verdict` run as usual. Values a pull request controls (the pinned version, service names) reach
the scripts only through environment variables, and service names must be plain directory names.

Hosted Ubuntu runners have Docker, so services with compose stacks (PostgreSQL, Redis, Kafka, stubs) run as they do
on a laptop.

## GitLab CI/CD

Two CI/CD components (`spec:inputs`) to publish in your own components project; `ci/Dockerfile` builds the pinned
image they run.

- `ci/gitlab/regression-gate.yml`: include once per service. Adds `vgate:gate:<service>` (merge requests and the
  default branch) and `vgate:guard:<service>` (merge requests). On a merge request each job first runs
  `vgate affected` and exits at once when its service is untouched.
- `ci/gitlab/pr-decision.yml`: include once. Adds `vgate:decide` in the `.post` stage: it runs after every other job,
  failed ones too, reads their evidence, upserts one merge-request note with the decision, and passes on `merge`,
  passes on `needs-approval` only once an eligible approver approved after the latest push, and fails on `blocked`.

```yaml
include:
  - component: $CI_SERVER_FQDN/<your-components-project>/regression-gate@1
    inputs:
      service: orders
      image: registry.example/your-group/vgate:0.6.2
  - component: $CI_SERVER_FQDN/<your-components-project>/regression-gate@1
    inputs:
      service: payments
      image: registry.example/your-group/vgate:0.6.2
  - component: $CI_SERVER_FQDN/<your-components-project>/pr-decision@1
    inputs:
      image: registry.example/your-group/vgate:0.6.2
      approvers: group:your-group/verification-owners, some.username
      automerge: false
```

Why one include per service and not a matrix generated from `vgate affected`: GitLab cannot build `parallel:matrix`
from a job's output without a child pipeline, and a child pipeline generated at run time is one more file whose
content nobody reviewed. Static includes are reviewed like any other CI change, the jobs of untouched services finish
in seconds, and a service that has no include is not silently skipped: `vgate decide` finds it affected, finds no
evidence and blocks.

`regression-gate` inputs:

| Input         | Default                       | Meaning                                                                            |
| ------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `service`     | required                      | The service's directory name                                                       |
| `image`       | required                      | The pinned vgate image (by version or digest; moving the pin is a reviewed change) |
| `environment` | `local`                       | The `service.yaml` environment                                                     |
| `reports_dir` | `reports`                     | vgate.yaml's `reportsDir`: deleted before each job, uploaded as the full reports   |
| `stage`       | `test`                        | The stage of both jobs                                                             |
| `services`    | a `docker:29.0.0-dind` daemon | CI services the stack needs; `[]` for a stack without Docker                       |
| `stack_host`  | `docker`                      | Exported as `STACK_HOST`: where the stack's published ports answer                 |

`pr-decision` inputs: `image` (the same pin), `approvers` (usernames and `group:<full/path>`, comma-separated),
`automerge` (default `false`: set merge requests decided `merge` to merge when the pipeline succeeds) and
`reports_dir` (as above).

The jobs run the image's vgate against the checkout (`--root`), so the service's directory comes from the project's
`servicesDir`. Evidence is only what vgate prints: every job deletes the reports directory before it runs and keeps
its scratch files outside the checkout, and `vgate:decide` takes the decision from `vgate decide --json`, never from a
file a merge request could have committed. Verdicts and guard reports name the commit they ran on; `vgate decide`
refuses evidence from another commit or a tree changed after it ran.

Set it up once per project:

- **Pipelines must succeed** (Settings > Merge requests) and a protected default branch.
- **A token.** `vgate:decide` posts the note, reads approvals and, with `automerge`, sets the merge, all through the
  API, which the job token cannot do. Create a project or group access token with scope `api` (role Developer when
  `automerge` is on, else Reporter) and store it as a masked, protected CI variable `VGATE_API_TOKEN`. Without it the
  decision still gates the pipeline; there is just no note, and `needs-approval` cannot pass.
- **CODEOWNERS** as the second lock: the judge's files and every `known-failures.yaml` need an approval from the
  verification owners, with "Require approval from code owners" on the protected default branch.

When the decision is `needs-approval`, `vgate:decide` lists the reasons and passes only when an approver from
`approvers` approved the merge request after its latest push:

- The author never counts.
- The time of the push is GitLab's (the merge request's latest diff version), not a commit date the author could
  write.
- An approval that is withdrawn does not count, and a push after the approval needs a new one.
- GitLab does not start pipelines on approval, so the approver re-runs the `vgate:decide` job.
- Any API error fails the job: the check fails closed.

What the runners need:

- **Docker for compose stacks.** A service whose stack has dependencies starts them with `docker compose` against a
  Docker-in-Docker daemon. The runner must allow privileged containers (Docker executor), or be a Kubernetes executor
  with a privileged `docker:dind` sidecar. A stack without Docker runs anywhere.
- **Ports.** With DinD, published ports answer on the `docker` host, not on `localhost`. A `service.yaml` writes its
  URLs as `http://${STACK_HOST:-localhost}:<port>` so the same file works on a laptop and in CI. On a Kubernetes
  executor, where the sidecar shares the pod's network, set `stack_host: localhost`.
- **Registry access** to pull the image.

Build and check the image locally: `pnpm task image:build`, then
`docker run --rm vgate:dev vgate doctor --service example --fix`.

## What was tested, and what was not

- **GitHub workflow:** passes actionlint and parses; its jq and shell snippets were exercised on sample data. It has
  not yet run on a real pull request, merge queue, fork or the `vgate-expectations` environment.
- **GitLab components:** both parse and every job script passes `bash -n`. The approval check
  (`ci/gitlab/approval-check.sh`) was tested against a stubbed GitLab API:
  - passes when approved after the push;
  - fails when approved before the push, self-approved by the author, approved then withdrawn, approved by someone
    not eligible, never approved, or run without a token;
  - handles username lists and group members.

  Its message on a `needs-approval` decision (the reasons read from `reports/decision.json`) was checked locally.

- **Image:** builds (arm64), and `vgate version`, `doctor --fix`, `skills list` and the gate's selftest, typecheck
  and lint steps pass inside it. The amd64 build was not run.
- **Not tested, because they need a GitLab instance:** the components' input interpolation, job rules on real
  merge-request events, artifacts reaching the `.post` job, the note upsert and the merge API calls, DinD with TLS on
  real runners, the token's permissions, and the merge-request test widget.
