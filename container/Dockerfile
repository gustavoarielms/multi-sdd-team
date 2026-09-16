FROM debian@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

LABEL org.opencontainers.image.source="https://github.com/gustavoarielms/multi-sdd-team"
LABEL org.opencontainers.image.version="0.154.0"
LABEL io.github.gustavoarielms.sdd-codegraph.contract-version="1"

COPY container/dist/codex-app-server-package-aarch64-unknown-linux-musl.tar.gz /tmp/codex-app-server.tar.gz
COPY --chmod=0555 container/dist/runtime-entrypoint-aarch64-unknown-linux-gnu /usr/local/libexec/sdd-codegraph/runtime-entrypoint
COPY container/licenses/openai-codex-LICENSE /usr/share/licenses/openai-codex/LICENSE
COPY container/licenses/openai-codex-NOTICE /usr/share/licenses/openai-codex/NOTICE

RUN set -eu; \
    printf '%s  %s\n' '295bb1b94a8b964b2d2461db9736b9907a9e4daa6ceb8e9bbb820b304fa897ed' '/tmp/codex-app-server.tar.gz' | sha256sum -c -; \
    mkdir -p /opt/openai/codex-app-server; \
    tar -xzf /tmp/codex-app-server.tar.gz -C /opt/openai/codex-app-server; \
    test -x /opt/openai/codex-app-server/bin/codex-app-server; \
    test -f /opt/openai/codex-app-server/codex-package.json; \
    rm /tmp/codex-app-server.tar.gz

ENV PATH="/opt/openai/codex-app-server/codex-path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    HOME="/run/codex" \
    CODEX_HOME="/run/codex"

USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/local/libexec/sdd-codegraph/runtime-entrypoint"]
CMD ["--listen", "stdio://"]
