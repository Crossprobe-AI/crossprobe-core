# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub: the repository's **Security**
tab, **Report a vulnerability**. Don't open a public issue for them.

Say what is affected, how to reproduce it (a minimal KiCad file helps when a file
triggers it), and what an attacker could do. You'll get an answer within a week, and
credit in the release notes if you'd like it.

## What is supported

The latest release, and `main`. Fixes are not backported to older versions.

## Scope

- **The editor in the browser**, including what it does with KiCad files it opens:
  a crafted `.kicad_*` file that runs script, reaches the network, or reads files the
  user didn't choose is in scope.
- **The dev server** (`npm run dev`, `docker compose up`) is a development tool. It
  serves this computer only (Docker publishes it on 127.0.0.1); exposing it to a
  network is not a supported setup.
