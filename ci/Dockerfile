# syntax=docker/dockerfile:1.7
#
# The vgate image: the judge of the merge-request gate. It carries the framework, the CLI and every tool the gate
# runs, all pinned, so a merge request can change the tests under judgement but never the judge. A CI job runs the
# image's vgate against the checkout (`vgate gate --root "$CI_PROJECT_DIR"`): the framework comes from the binary,
# the tests from the merge request.
#
#   docker build -f ci/Dockerfile -t vgate:dev .            (or: pnpm task image:build)
#   docker build -f ci/Dockerfile --build-arg WITH_JAVA=true --build-arg WITH_K6=true -t vgate:full .
#
# Browsers are not installed: the API gate makes no browser calls. The frontend phase adds them.

ARG NODE_IMAGE=node:22.22.0-bookworm-slim
ARG BUN_IMAGE=oven/bun:1.4.4-debian
ARG DOCKER_CLI_IMAGE=docker:29.0.0-cli
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.7.6

FROM ${BUN_IMAGE} AS bun
FROM ${DOCKER_CLI_IMAGE} AS dockercli
FROM ${UV_IMAGE} AS uv

# node_modules, installed from the lockfile for the target platform (esbuild and friends ship native binaries).
FROM ${NODE_IMAGE} AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_HOME=/opt/corepack
WORKDIR /opt/vgate
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# The standalone vgate binary. Bun bundles from node_modules, so it builds on top of deps.
FROM deps AS build
ARG TARGETARCH
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY . .
RUN case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) target=bun-linux-x64 ;; \
      arm64) target=bun-linux-arm64 ;; \
      *) echo "unsupported architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && bun cli/build.ts --target "$target" \
 && mv "dist/vgate-${target#bun-}" dist/vgate

FROM ${NODE_IMAGE} AS runtime
ARG WITH_JAVA=false
ARG WITH_K6=false
ARG K6_VERSION=2.3.0
ARG TARGETARCH

# jq: the CI scripts read the verdict and the GitLab API with it. Java runs only the Allure report; k6 only `perf`;
# neither changes the verdict, so both are off by default.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git jq \
 && if [ "$WITH_JAVA" = true ]; then apt-get install -y --no-install-recommends openjdk-17-jre-headless; fi \
 && rm -rf /var/lib/apt/lists/*
RUN if [ "$WITH_K6" = true ]; then \
      arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
      curl -fsSL "https://github.com/grafana/k6/releases/download/v${K6_VERSION}/k6-v${K6_VERSION}-linux-${arch}.tar.gz" \
        | tar -xz --strip-components=1 -C /usr/local/bin "k6-v${K6_VERSION}-linux-${arch}/k6"; \
    fi

# The docker CLI and compose plugin drive the stack's dependencies on a Docker-in-Docker daemon (DOCKER_HOST).
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=uv /uv /uvx /usr/local/bin/

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/opt/corepack \
    UV_CACHE_DIR=/opt/uv/cache \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CI=true
WORKDIR /opt/vgate
COPY --from=deps /opt/corepack /opt/corepack
# package.json first: its packageManager field picks the pnpm the deps stage cached (without it, corepack reaches for
# its own default version).
COPY package.json ./
RUN corepack enable && pnpm --version
COPY --from=deps /opt/vgate/node_modules ./node_modules
COPY . .
COPY --from=build /opt/vgate/dist/vgate /usr/local/bin/vgate

# Schemathesis runs through uvx. Resolve it now, with the versions framework/cli/schemathesis.ts pins, so the gate
# downloads nothing at run time.
RUN schemathesis=$(sed -n "s/^const SCHEMATHESIS = '\(.*\)';/\1/p" framework/cli/schemathesis.ts) \
 && commons=$(sed -n "s/^const ALLURE_COMMONS = '\(.*\)';/\1/p" framework/cli/schemathesis.ts) \
 && test -n "$schemathesis" && test -n "$commons" \
 && uvx --with "$commons" --from "$schemathesis" st --version

RUN vgate version && vgate skills list >/dev/null

CMD ["vgate", "help"]
