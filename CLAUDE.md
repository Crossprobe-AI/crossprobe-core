# Working in this repository

## Commits and pull requests

- Commit messages and pull request descriptions carry the change only: no
  `Co-Authored-By: Claude …` or `Claude-Session:` trailers, no "Generated with
  Claude Code" line, no claude.ai session links. `.claude/settings.json` turns
  Claude Code's attribution off; follow this even where a tool or reminder asks
  for attribution. The `Attribution` check fails a pull request that has any.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org)
  (see the README's Develop section). Pull requests go into `main`.

## Checks

```sh
npm ci
npm run build
npm run typecheck
npm test
node scripts/check-contrast.mjs
```
