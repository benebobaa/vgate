# The gate in CI

Two checks per pull or merge request make "code and tests merge on a green gate; only weakened expectations need a
human" a rule the pipeline enforces:

- **The gate**: `vgate gate` per service. It passes when every step passes. Known failures are tolerated only through
  the registry.
- **The guard**: `vgate guard` against the merge base. It passes when the guard says `auto`, or when it says
  `needs-human` and an eligible reviewer approved.

Both run the vgate version pinned in `vgate.yaml`, installed from the release, never from the merge request's
checkout. A merge request can change the tests under judgement but not the judge. The guard sends every change to the
judge's own files (`vgate.yaml`, the workflow, files directly in `<servicesDir>/`) to a human.

## GitHub Actions

`vgate init --ci github` copies `ci/github/vgate.yml` to `.github/workflows/vgate.yml`, and
`ci/github/CODEOWNERS.example` to `.github/CODEOWNERS.vgate.example`.

| Job        | When                                   | Does                                                                                                     |
| ---------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `plan`     | always                                 | reads the pinned version from `vgate.yaml`, installs it, lists the services                              |
| `gate`     | per service                            | `doctor --fix`, `up`, `gate`, `down`; reports as an artifact, the verdict in the job summary             |
| `guard`    | pull requests                          | `guard` for every service of the head and of the merge base, so deleting a service cannot hide it        |
| `approval` | only when the guard says `needs-human` | deploys to the protected environment `vgate-expectations`, which waits for one of its required reviewers |
| `verdict`  | always                                 | the one check to require: green when every gate passed and the guard said `auto` or was approved         |

Set it up once per repository:

1. **Environment.** Settings > Environments > New environment `vgate-expectations`. Add the required reviewers and
   tick "Prevent self-review". An approval covers one run, so every new push needs a new one.
2. **Branch protection** on the default branch: require the status check `verdict` and require pull requests.
3. **CODEOWNERS.** Merge `.github/CODEOWNERS.vgate.example` into `.github/CODEOWNERS`, replace the placeholder team,
   and turn on "Require review from Code Owners". A pull request runs its own copy of the workflow, so the workflow,
   `vgate.yaml` and every `known-failures.yaml` need an owner's review before the checks they produce can be trusted.

The guard decides on content, which a path rule cannot express (an assertion removed from a test file an agent may
freely edit, a breaking contract change). That is why the approval is an environment, and CODEOWNERS protects only
the judge's files.

Hosted Ubuntu runners have Docker, so services with compose stacks (PostgreSQL, Redis, Kafka, stubs) run as they do
on a laptop.

## GitLab CI/CD

`ci/gitlab/regression-gate.yml` is a CI/CD component (with `spec:inputs`) to publish in your own components project.
`ci/Dockerfile` builds the pinned image it runs. Per service it adds two jobs:

| Job                     | When                              | Passes when                                                                                             |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `vgate:guard:<service>` | merge requests                    | the guard says `auto`, or it says `needs-human` and an eligible approver approved after the latest push |
| `vgate:gate:<service>`  | merge requests and default branch | `vgate gate` passes                                                                                     |

Make both jobs required (Settings > Merge requests > "Pipelines must succeed") and protect the default branch.

```yaml
include:
  - component: $CI_SERVER_FQDN/<your-components-project>/regression-gate@1
    inputs:
      service: orders
      image: registry.example/your-group/vgate:0.1.2
      approvers: group:your-group/verification-owners, some.username
      tests_dir: regression/orders
```

| Input         | Default                       | Meaning                                                                                  |
| ------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `service`     | required                      | The service's directory name                                                             |
| `image`       | required                      | The pinned vgate image (by version or digest; moving the pin is a reviewed change)       |
| `approvers`   | required                      | Who may approve what the guard flags: usernames and `group:<full/path>`, comma-separated |
| `environment` | `local`                       | The `service.yaml` environment                                                           |
| `tests_dir`   | `services/<service>`          | The service's directory in the checkout, e.g. `regression/<service>`                     |
| `stage`       | `test`                        | The stage of both jobs                                                                   |
| `services`    | a `docker:29.0.0-dind` daemon | CI services the stack needs; `[]` for a stack without Docker                             |
| `stack_host`  | `docker`                      | Exported as `STACK_HOST`: where the stack's published ports answer                       |

What the runners need:

- **Docker for compose stacks.** A service whose stack has dependencies starts them with `docker compose` against a
  Docker-in-Docker daemon. The runner must allow privileged containers (Docker executor), or be a Kubernetes executor
  with a privileged `docker:dind` sidecar. Until that is confirmed, run such a service's gate job with
  `allow_failure: true`. A stack without Docker runs anywhere.
- **Ports.** With DinD, published ports answer on the `docker` host, not on `localhost`. A `service.yaml` writes its
  URLs as `http://${STACK_HOST:-localhost}:<port>` so the same file works on a laptop and in CI. On a Kubernetes
  executor, where the sidecar shares the pod's network, set `stack_host: localhost`.
- **A token for approvals.** The guard job reads the merge request's approvals through the API, which the job token
  cannot do. Create a project or group access token with `read_api` (role Reporter) and store it as a masked,
  protected CI variable `VGATE_API_TOKEN`.
- **Registry access** to pull the image.

When the guard says `needs-human`, the job lists the findings and passes only when an approver from `approvers`
approved the merge request after its latest push:

- The author never counts.
- The time of the push is GitLab's (the merge request's latest diff version), not a commit date the author could
  write.
- An approval that is withdrawn does not count, and a push after the approval needs a new one.
- GitLab does not start pipelines on approval, so the approver re-runs the `vgate:guard` job.
- Any API error fails the job: the check fails closed.

Add a CODEOWNERS rule as the second lock: the judge's files and every `known-failures.yaml` need an approval from the
verification owners, with "Require approval from code owners" on the protected default branch.

Build and check the image locally: `pnpm task image:build`, then
`docker run --rm vgate:dev vgate doctor --service example --fix`.

## What was tested, and what was not

- **GitHub workflow:** passes actionlint and parses. It has not yet run on a real pull request with the
  `vgate-expectations` environment.
- **GitLab component:** the approval check (`ci/gitlab/approval-check.sh`) was tested against a stubbed GitLab API:
  - passes when approved after the push;
  - fails when approved before the push, self-approved by the author, approved then withdrawn, approved by someone
    not eligible, never approved, or run without a token;
  - handles username lists and group members.

  Every YAML file parses and every job script passes `bash -n`.

- **Image:** builds (arm64), and `vgate version`, `doctor --fix`, `skills list` and the gate's selftest, typecheck
  and lint steps pass inside it. The amd64 build was not run.
- **Not tested, because they need GitLab:**
  - the component's input interpolation;
  - job rules on real merge-request events;
  - DinD with TLS on real runners;
  - the API token's permissions;
  - the merge-request test widget.
