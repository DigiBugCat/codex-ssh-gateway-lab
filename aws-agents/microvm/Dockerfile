# Executor image for Lambda MicroVMs: one `codex exec-server` per MicroVM.
FROM public.ecr.aws/amazonlinux/amazonlinux:2023
RUN dnf install -y tar gzip findutils git which procps-ng && dnf clean all
# Pinned release, verified by checksum before install.
ARG CODEX_URL=https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-aarch64-unknown-linux-musl.tar.gz
ARG CODEX_SHA256=eb677c80f666b1ab8b4b1d083b66e8d614b1281d960bb6f9fd8ca98f58b38b90
RUN curl -sSfL "$CODEX_URL" -o /tmp/codex.tgz \
 && echo "$CODEX_SHA256  /tmp/codex.tgz" | sha256sum -c - \
 && tar -xzf /tmp/codex.tgz -C /tmp \
 && install -m 0755 /tmp/codex-aarch64-unknown-linux-musl /usr/local/bin/codex \
 && rm -f /tmp/codex.tgz /tmp/codex-aarch64-unknown-linux-musl
RUN useradd -m agent && mkdir -p /workspace/proj && chown -R agent:agent /workspace
USER agent
WORKDIR /workspace
EXPOSE 8080
CMD ["/usr/local/bin/codex", "exec-server", "--listen", "ws://0.0.0.0:8080"]
