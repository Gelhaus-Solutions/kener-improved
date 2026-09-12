# The standalone Kener probe (B1c).
#
# **Build from the repository root, not from this directory:**
#
#     docker build -f probe/Dockerfile -t kener-probe .
#
# The probe reuses Kener's own service classes by relative import, so the build
# stage needs `src/` and the root `node_modules`. That is the trade the design
# makes deliberately: one copy of the check logic, at the cost of a build context
# larger than the thing being built. The runtime stage copies nothing but the
# bundle, so the image itself stays small and holds no Kener source.

FROM node:22-alpine AS build

WORKDIR /repo

# Dependencies first, so a change to the probe's source does not re-run the
# install. The probe bundles axios, cheerio, ping, dns2 and ws out of the root
# install; it has no separate dependency tree of its own.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Only what the bundle actually reaches. Copying the whole repository would put
# migrations, seeds and the SvelteKit app into a layer that is thrown away.
COPY knexfile.ts ./
COPY src/lib ./src/lib
COPY probe ./probe

RUN node probe/build.js

FROM node:22-alpine AS runtime

# `pingCall` shells out to the system `ping` binary through the `ping` package,
# so a PING monitor on an image without it fails with a confusing ENOENT rather
# than a timeout. Alpine's busybox ping cannot be used unprivileged, which is
# why this is iputils rather than nothing.
RUN apk add --no-cache iputils

WORKDIR /app

# The bundle and nothing else: no node_modules, no package.json, no source.
COPY --from=build /repo/probe/dist/probe.js ./probe.js

# Not root. The probe opens outbound sockets and needs no privilege beyond that.
USER node

ENV NODE_ENV=production

# KENER_PROBE_URL   ws://kener-host:3390  - where to connect
# KENER_PROBE_TOKEN the token shown once when the agent was created; a
#                   comma-separated list serves several organisations from one
#                   container, one session per token
# KENER_PROBE_VERSION optional, reported to Kener and shown on the probes screen
#
# No HEALTHCHECK: the probe is a client, so it exposes no port to poll. Whether
# it is doing its job is a question only Kener can answer, and the probes screen
# is where that answer lives.
CMD ["node", "probe.js"]
