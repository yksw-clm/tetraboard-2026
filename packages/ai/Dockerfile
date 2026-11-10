FROM rust:1.99.1-slim-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY configs ./configs
RUN cargo build --release --locked --jobs 2 -p tetraboard-ai-server

FROM gcc:14-bookworm AS shogi
ARG TARGETARCH
WORKDIR /yaneuraou
ADD --checksum=sha256:9eb11fa7495fddd5c24522ec40faac7896a92a4ba274a8baf1f951f318e54575 https://github.com/yaneurao/YaneuraOu/releases/download/v4.73_book/standard_book.zip /tmp/standard_book.zip
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
    && unzip -p /tmp/standard_book.zip standard_book.db > /yaneuraou/standard_book.db
RUN git init && git fetch --depth=1 https://github.com/yaneurao/YaneuraOu.git faeb37f08b63fd1fd99fd18512fcdeb945975c21 \
    && git checkout --detach FETCH_HEAD \
    && git archive --format=tar.gz --output=/yaneuraou-source.tar.gz HEAD
RUN case "$TARGETARCH" in amd64) cpu=SSE42 ;; arm64) cpu=ARMV8 ;; *) exit 1 ;; esac \
    && make -C source -j2 normal COMPILER=g++ TARGET_CPU="$cpu" \
       YANEURAOU_EDITION=YANEURAOU_ENGINE_MATERIAL MATERIAL_LEVEL=001 \
       EXTRA_LDFLAGS='-static-libstdc++ -static-libgcc'

FROM debian:bookworm-slim
RUN groupadd --gid 10001 ai && useradd --uid 10001 --gid ai --no-create-home ai
COPY --from=build /build/target/release/tetraboard-ai-server /usr/local/bin/tetraboard-ai-server
COPY --from=shogi /yaneuraou/source/YaneuraOu-by-gcc /usr/local/bin/yaneuraou
COPY --from=shogi /yaneuraou/standard_book.db /usr/local/bin/book/standard_book.db
COPY --from=shogi /yaneuraou-source.tar.gz /yaneuraou/LICENSE /usr/local/share/yaneuraou/
USER 10001:10001
ENV AI_SERVICE_LISTEN=0.0.0.0:3001
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/tetraboard-ai-server"]
