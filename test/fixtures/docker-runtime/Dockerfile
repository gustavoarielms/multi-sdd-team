FROM rust@sha256:09e98f39fa15751de9476fefafe4be0e4ef92b292d608410595bbbde9ebdd375 AS build
WORKDIR /src
COPY main.rs /src/main.rs
RUN rustc --edition=2024 --test main.rs -o /tmp/fixture-tests && /tmp/fixture-tests && \
    rustc --edition=2024 -O -C strip=symbols -C debuginfo=0 -C link-arg=-Wl,--build-id=none \
      --remap-path-prefix=/src=fixture main.rs -o /tmp/fixture

FROM debian@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132
LABEL org.opencontainers.image.source="https://github.com/gustavoarielms/multi-sdd-team"
LABEL org.opencontainers.image.version="0.154.0"
LABEL io.github.gustavoarielms.sdd-codegraph.contract-version="1"
COPY --from=build --chmod=0555 /tmp/fixture /usr/local/libexec/sdd-codegraph/runtime-entrypoint
ENV PATH="/opt/openai/codex-app-server/codex-path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    HOME="/run/codex" \
    CODEX_HOME="/run/codex"
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/local/libexec/sdd-codegraph/runtime-entrypoint"]
CMD ["--listen", "stdio://"]
