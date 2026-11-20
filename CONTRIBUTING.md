# Contributing

Thanks for helping. Bug reports with a KiCad file that shows the problem are the most
useful thing you can send; pull requests are welcome too.

## Before you start

- **Bugs and features:** open an issue first for anything bigger than a small fix, so we
  can agree on the approach. For a KiCad behaviour, say what KiCad does (version, menu,
  the result) and add a small file if you can.
- **Parity with KiCad** is the goal: the [KiCad parity](README.md#kicad-parity) table
  says what works. A change that adds or fixes a KiCad feature updates its row in the
  same pull request.
- **No KiCad source code.** KiCad is GPL-3.0 and this project is Apache-2.0: its
  behaviour is reimplemented here and checked against what KiCad does, but its code is
  never copied or translated ([NOTICE](NOTICE)). Reading KiCad's documentation and
  comparing outputs is fine.

## Setting up

Node.js 22.12 or later (`.nvmrc`). Then:

```sh
npm ci
npm run build       # the two packages
npm run dev         # the app at http://localhost:5173
```

KiCad's libraries are read from a KiCad installation, or from `KICAD_SYMBOLS`,
`KICAD_FOOTPRINTS` and `KICAD_DEMOS`. Docker works too ([docs/docker.md](docs/docker.md)).

## Checks

```sh
npm run typecheck
npm test                                # npx playwright install chromium, the first time
node scripts/check-contrast.mjs         # after changing the app's colours
```

Many tests compare with KiCad on its demo projects and skip when KiCad or the demos are
missing, and so do they on GitHub. If you change the model, the checks or the exports,
run `npm test` with KiCad and its demos ([README, Develop](README.md#develop)). The
browser scripts in `scripts/e2e-*.mjs` drive the app end to end
([docs/end-to-end.md](docs/end-to-end.md)).

## Pull requests

- Keep each one to one change, with tests for what it fixes or adds.
- The title is a [Conventional Commit](https://www.conventionalcommits.org): `fix:`,
  `feat:` (`feat!:` when it breaks something), `docs:`, `test:`, `ci:`. Releases and the
  changelog are made from these.
- Say how you checked it, and whether the KiCad comparisons ran.

By sending a pull request you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), like the rest of the project.
