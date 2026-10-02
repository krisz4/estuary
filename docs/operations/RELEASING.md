# Releasing

How a version of Estuary is cut and published. Pushing a `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which publishes three things:

| Artifact | Where | Used by |
| -------- | ----- | ------- |
| `estuary-mcp` | npm | The Claude Code plugin (when there's no local checkout), `npx -y estuary-mcp`, any other MCP client |
| `estuary-api`, `estuary-web` | `ghcr.io/krisz4/`, for `linux/amd64` and `linux/arm64` | [`deploy/docker-compose.yml`](../../deploy/docker-compose.yml) and self-hosters |
| GitHub release | the repo's Releases page | People reading what changed. The notes are that version's `CHANGELOG.md` section |

## Versioning

[Semantic Versioning](https://semver.org/). **All workspaces share one version**, and so does the plugin manifest (`integrations/claude-code/.claude-plugin/plugin.json`). The plugin's launcher runs `estuary-mcp@<its own version>`, so the plugin and the server it starts can never drift apart. The release workflow refuses a tag that disagrees with any of these files.

While the version is `0.x`, a minor bump may break things: the API, the MCP tools, or the database (through a migration). Say so under **Changed** in the changelog, with what the user has to do. Images get `X.Y.Z`, `X.Y`, and `latest` tags, but no bare major tag before 1.0.

## Cutting a release

1. **Start from a green `main`.** The release workflow doesn't re-run the tests; it trusts that CI passed on the tagged commit.
2. **Bump the version** everywhere at once, from the repo root:

   ```bash
   V=0.2.0
   for f in package.json apps/*/package.json packages/*/package.json integrations/claude-code/.claude-plugin/plugin.json; do
     node -e "const f='$f',j=require('./'+f);j.version='$V';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
   done
   pnpm format
   ```

3. **Update `CHANGELOG.md`:** rename `## [Unreleased]` to `## [0.2.0] - YYYY-MM-DD`, add a fresh empty `## [Unreleased]` above it, and update the compare links at the bottom.
4. **Commit and merge** as `Release v0.2.0` through a normal PR.
5. **Tag the merge commit** on `main` and push the tag:

   ```bash
   git switch main && git pull
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

6. **Watch the Release workflow.** If `check` fails, nothing was published: delete the tag (`git push --delete origin v0.2.0 && git tag -d v0.2.0`), fix the problem, and tag again. If a later job fails partway, re-run only the failed job. npm refuses to publish the same version twice, so never reuse a version that reached npm; release the next patch instead.

## One-time setup (repository owner)

- **npm:** create an npm automation token that can publish `estuary-mcp`, and add it as the repository secret `NPM_TOKEN`, scoped to the `npm` environment the workflow uses. After the first publish you can switch to npm's trusted publishing (OIDC) for this repository and workflow, and delete the token.
- **GHCR:** nothing to set up; the workflow pushes with `GITHUB_TOKEN`. After the first release, open each package (`estuary-api`, `estuary-web`) under the owner's **Packages** tab, set its visibility to **Public**, and link it to this repository.

## Upgrading from a pre-rename checkout

Before 0.1.0 the project was called `helpdesk`. If you ran an earlier checkout:

- **Local database.** The default file is now `apps/api/prisma/data/estuary.db`. If your `apps/api/.env` still says `DATABASE_URL=file:./data/helpdesk.db`, it keeps working as it is. To match the new default, stop the API, rename the file (and its `-journal`/`-wal` siblings if they exist), and update the `.env` line.
- **Docker volume.** The compose project and volume are now `estuary` / `estuary-db`, so `docker compose up` starts with an empty database. To keep your data, copy it across once:

  ```bash
  # The labels make compose treat this as its own volume, not an external one.
  docker volume create estuary_estuary-db \
    --label com.docker.compose.project=estuary --label com.docker.compose.volume=estuary-db
  docker run --rm -v helpdesk_helpdesk-db:/from -v estuary_estuary-db:/to alpine \
    sh -c 'cp -a /from/. /to/ && mv /to/helpdesk.db /to/estuary.db'
  ```

- **Claude Code plugin.** The plugin and its marketplace are now both called `estuary`, the marketplace manifest moved to the repository root, and the tools are now `mcp__plugin_estuary_tasks__*`. Remove the old one and install the new one:

  ```bash
  claude plugin uninstall task-manager@helpdesk-tasks
  claude plugin marketplace remove helpdesk-tasks
  ```

  Then follow [../features/Agent_Integration.md](../features/Agent_Integration.md).
- **Browser preferences** (theme, display name, API token, list/map view) carry over by themselves: the first page load copies the old `helpdesk.*` `localStorage` keys to `estuary.*`.

## Related

- [CI.md](./CI.md): the checks a commit must pass before it can be tagged
- [DOCKER.md](./DOCKER.md): what's inside the images
- [../../CHANGELOG.md](../../CHANGELOG.md)
