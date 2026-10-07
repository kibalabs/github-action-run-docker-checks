# GitHub Action - Run Docker Checks

Run a project's checks (lint, type-check, tests, ...) in parallel docker containers and report each one as its own GitHub check, with its result, its log and any annotations.

All checks start at once from the same image, so a job takes as long as its slowest check instead of the sum of them. Each named check appears on the pull request as soon as it starts, and its details show the end of its log, so a failing test can be read without opening the job.

## Example

```yaml
jobs:
  api-check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      checks: write
    steps:
      - uses: actions/checkout@v7
      - name: Build docker image
        run: docker build --tag api ./api
      - uses: kibalabs/github-action-run-docker-checks@v1
        with:
          image: api
          annotations-path-prefix: ./api/
          checks: |
            - name: lint
              command: make lint-check-ci
              check-name: api-lint
              annotations-file: lint-check-results.json
            - name: tests
              command: make test
              check-name: api-tests
            - name: openapi
              command: make generate-openapi
              stdout-file: docs/openapi.json
```

The step fails when any check fails. Every check's full log is printed in its own collapsible group, and the job summary gets a table of results.

## Checks

`checks` is a YAML list. Each check has:

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Short unique name, used for the container and the log group. |
| `command` | yes | Run with `sh -c` in the image, ignoring the image's `ENTRYPOINT`, in the image's working directory. Quote it if it contains `: `. |
| `check-name` | no | Report this check as its own GitHub check with this name. |
| `annotations-file` | no | JSON file the command writes inside the container, in the [create-annotations](https://github.com/kibalabs/github-action-create-annotations) format, attached to the check. Needs `check-name`. Relative paths start from the image's working directory. |
| `stdout-file` | no | Save the command's standard output to this file in the workspace, e.g. to compare generated files afterwards. |

A check passes when its command exits with 0. Annotations are added to the check but don't change its result.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `image` | | Docker image to run every check in. |
| `checks` | | The checks, see above. |
| `annotations-path-prefix` | `''` | Added to the paths in every annotations file, e.g. `./api/` when the image is built from that folder. |
| `github-token` | `${{ github.token }}` | Needs `checks: write`. Pull requests from forks only get a read-only token: the checks still run, but aren't reported as separate checks. |

## Outputs

| Output | Description |
| --- | --- |
| `failed-checks` | Comma-separated names of the checks that failed. |

## With Skip If Passed

When [Skip If Passed](https://github.com/kibalabs/github-action-skip-if-passed) decides a job can be skipped, it sets `CHECKS_ALREADY_PASSED=true` and this action does nothing. Its checks set `external_id` to the workflow run's id, so Skip If Passed copies them onto the skipped commit.

If the job is cancelled or times out, a post step marks any checks that didn't finish as cancelled and force-removes their containers.

## Development

Build with `make build`, which bundles `src/` into `runnable/index.js`. GitHub runs that file directly, so commit it with every source change. Run the tests with `make test`.

To release, bump `version` in `package.json` in a PR, then run the Release workflow on `main` (Actions → Release → Run workflow). It tags `vX.Y.Z`, publishes the release and moves the `vX` tag to it, so `@v1` always points at the latest 1.x release. Versions with a pre-release suffix (e.g. `1.1.0-rc1`) are published as pre-releases and don't move `vX`. Only the release workflow can push version tags.
