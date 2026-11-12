# Phase 0 placeholder. Full image (with mcap, rosbags, neo4j drivers, etc.) lands in Phase 3.
FROM python:3.11-slim

# TARGETARCH is provided by BuildKit (amd64 / arm64).
ARG TARGETARCH

WORKDIR /app

# Runtime libs for the vendored `mcap` DuckDB extension (query_mcap tool).
# The extension dynamically links:
#   - liblz4.so.1     -> available natively in bookworm (liblz4-1)
#   - libprotobuf.so.23 -> NOT in bookworm (which ships .so.32). The release
#     binaries are built on Ubuntu 22.04 (jammy, protobuf 3.12 -> soname 23),
#     so we graft jammy's libprotobuf.so.23 into the image to match.
#     (zstd symbols come from DuckDB's bundled copy — no runtime dep.)
# The .deb comes from Canonical's archive, or from one of two independent
# mirrors of it when Canonical is unreachable (its DNS included). The sha256
# pin means every mirror has to serve the identical file.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends liblz4-1 curl ca-certificates; \
    case "$TARGETARCH" in \
        amd64) \
            deb_arch=amd64; \
            mirrors="https://archive.ubuntu.com/ubuntu https://mirrors.ocf.berkeley.edu/ubuntu https://mirror.us.leaseweb.net/ubuntu"; \
            sha256="8c9942e9130ab7c343438b1b81603bdd86509d7e2a9cc877ae35a998dbf5e0a8"; \
            ;; \
        arm64) \
            deb_arch=arm64; \
            mirrors="https://ports.ubuntu.com/ubuntu-ports https://mirrors.ocf.berkeley.edu/ubuntu-ports https://mirror.us.leaseweb.net/ubuntu-ports"; \
            sha256="fe71603a014d2458db3b6f938d0a7d4c345c06c6d3c99a7e350873776e0fd0a8"; \
            ;; \
        *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    deb="libprotobuf23_3.12.4-1ubuntu7_${deb_arch}.deb"; \
    for mirror in $mirrors; do \
        if curl -fsSL --connect-timeout 20 --max-time 120 "${mirror}/pool/main/p/protobuf/${deb}" -o /tmp/libprotobuf23.deb \
            && echo "${sha256}  /tmp/libprotobuf23.deb" | sha256sum -c -; then \
            break; \
        fi; \
        echo "Couldn't get ${deb} from ${mirror}" >&2; \
        rm -f /tmp/libprotobuf23.deb; \
    done; \
    if [ ! -f /tmp/libprotobuf23.deb ]; then \
        echo "Couldn't download ${deb} from any mirror" >&2; exit 1; \
    fi; \
    dpkg-deb -x /tmp/libprotobuf23.deb /tmp/pb; \
    cp -a /tmp/pb/usr/lib/*/libprotobuf.so.23* /usr/lib/; \
    ldconfig; \
    rm -rf /tmp/libprotobuf23.deb /tmp/pb; \
    apt-get purge -y curl; apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

# uv for fast, reproducible installs
RUN pip install --no-cache-dir uv

COPY pyproject.toml ./
# Pre-install CPU-only PyTorch to avoid CUDA / Nvidia runtime wheels (saves ~3.8GB)
RUN uv pip install --system --no-cache --index-url https://download.pytorch.org/whl/cpu torch
# Install core + AI dependencies
RUN uv pip install --system --no-cache -r pyproject.toml --extra ai

COPY app ./app

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
