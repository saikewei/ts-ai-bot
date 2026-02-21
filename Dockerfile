FROM node:22-bookworm AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    build-essential \
    pkg-config \
    cmake \
    libopus-dev \
    libssl-dev \
  && rm -rf /var/lib/apt/lists/*

RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

COPY package.json package-lock.json tsconfig.json index.js index.d.ts ./
COPY native ./native
COPY rust ./rust
COPY src ./src

RUN npm ci
RUN cargo build --release --manifest-path native/tsclientlib-node/Cargo.toml \
  && npm run prepare:native \
  && npx tsc -p tsconfig.json \
  && if command -v strip >/dev/null 2>&1; then strip --strip-unneeded native/tsclientlib-node/index.node; fi

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    libstdc++6 \
    libopus0 \
    libssl3 \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/index.js /app/index.d.ts ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/native/tsclientlib-node/index.js /app/native/tsclientlib-node/index.d.ts /app/native/tsclientlib-node/index.node ./native/tsclientlib-node/

CMD ["node", "dist/main.js"]
