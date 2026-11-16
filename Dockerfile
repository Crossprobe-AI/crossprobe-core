# The web app's dev server with KiCad's symbol, footprint and demo libraries.
# See docs/docker.md. Build and run with `docker compose up --build`.
#
# Build args:
#   KICAD_3D=1     also install KiCad's 3D models (kicad-packages3d, about 4.7 GB).
#   KICAD_LIBS=0   install no KiCad libraries (you mount your own; docs/docker.md).
#
# Behind a proxy that re-signs TLS, pass its CA certificate as a build secret
# (apt then uses https, and npm trusts the certificate); the standard
# HTTPS_PROXY / NO_PROXY build args are honoured as usual:
#   docker build --secret id=ca,src=/path/to/ca.crt --build-arg HTTPS_PROXY=... .

# Debian 13 (trixie) packages KiCad 9's libraries.
FROM node:22-trixie-slim

ARG KICAD_LIBS=1
ARG KICAD_3D=0

RUN --mount=type=secret,id=ca,required=false \
    set -eu; \
    if [ "$KICAD_LIBS" != "1" ] && [ "$KICAD_3D" != "1" ]; then exit 0; fi; \
    if [ -s /run/secrets/ca ]; then \
      sed -i 's|http://deb.debian.org|https://deb.debian.org|' /etc/apt/sources.list.d/debian.sources; \
      echo 'Acquire::https::CAInfo "/run/secrets/ca";' > /etc/apt/apt.conf.d/99extra-ca; \
    fi; \
    apt-get update; \
    if [ "$KICAD_LIBS" = "1" ]; then apt-get install -y --no-install-recommends kicad-symbols kicad-footprints kicad-demos; fi; \
    if [ "$KICAD_3D" = "1" ]; then apt-get install -y --no-install-recommends kicad-packages3d; fi; \
    sed -i 's|https://deb.debian.org|http://deb.debian.org|' /etc/apt/sources.list.d/debian.sources; \
    rm -rf /etc/apt/apt.conf.d/99extra-ca /var/lib/apt/lists/*

ENV KICAD_DEMOS=/usr/share/kicad/demos \
    KICAD_SYMBOLS=/usr/share/kicad/symbols \
    KICAD_FOOTPRINTS=/usr/share/kicad/footprints \
    KICAD_3DMODELS=/usr/share/kicad/3dmodels

# The image's `node` user (uid 1000).
WORKDIR /app
RUN chown node:node /app
USER node

# Dependencies first, so source edits don't reinstall them. Only the workspaces
# copied here are installed (npm ci skips workspaces that are not present).
COPY --chown=node:node package.json package-lock.json tsconfig.base.json ./
COPY --chown=node:node apps/web/package.json apps/web/
RUN --mount=type=bind,source=packages,target=/tmp/packages \
    mkdir -p /app/packages && cd /tmp/packages \
    && find . -mindepth 2 -maxdepth 2 -name package.json -exec cp --parents {} /app/packages/ \;
RUN --mount=type=secret,id=ca,required=false,uid=1000 \
    --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --no-audit --no-fund

COPY --chown=node:node packages/ packages/
COPY --chown=node:node apps/web/ apps/web/
COPY --chown=node:node blocks/ blocks/
COPY --chown=node:node third_party/ third_party/
RUN npm run build

EXPOSE 5173
# Builds the packages (a no-op when up to date) and starts Vite on all interfaces.
CMD ["sh", "-c", "npm run build && exec npm run dev -w @crossprobe/web -- --host 0.0.0.0 --port 5173 --strictPort"]
