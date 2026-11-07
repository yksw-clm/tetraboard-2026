FROM rust:1.99.1-slim-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --locked --jobs 2 -p tetraboard-ai-server

FROM debian:bookworm-slim
RUN groupadd --gid 10001 ai && useradd --uid 10001 --gid ai --no-create-home ai
COPY --from=build /build/target/release/tetraboard-ai-server /usr/local/bin/tetraboard-ai-server
USER 10001:10001
ENV AI_SERVICE_LISTEN=0.0.0.0:3001
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/tetraboard-ai-server"]
