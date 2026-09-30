# Portable releases and Homebrew

The public GitHub Release asset and the Homebrew formula share one archive and
one SHA256 checksum. The release version and GitHub repository come from
`package.json`. Build the archive from the exact source revision you intend to
release, after updating the version and completing the terminal harness checks.

## Build and verify

Use Node.js 22.6 or newer, npm, and `tar`. The builder needs no dependency
installation or registry access. It uses `npm pack --offline --ignore-scripts`
to apply the package's published file list without running lifecycle scripts.
It writes outside the checkout by default and removes its temporary npm cache.

```bash
npm test
npm run lint
node --test test/release.test.js
node scripts/build-release.js --out /tmp/toris-agent-release
```

The last command prints JSON containing the archive, checksum file, formula,
version, and exact release URL. With version `0.5.0`, the output contains:

```text
/tmp/toris-agent-release/toris-agent-0.5.0.tgz
/tmp/toris-agent-release/SHA256SUMS
/tmp/toris-agent-release/Formula/toris-agent.rb
```

The builder defaults to `/tmp/toris-agent-release-<version>` on systems whose
temporary directory is `/tmp`. Keep a custom `--out` directory outside the
checkout, or use an ignored directory such as `dist/release`.

The packaging test builds and extracts the actual archive, executes the generated
wrapper with paths containing spaces, initializes an isolated solo project, and
checks that an offline dry run produces tasks with zero cost. It also verifies
that the JavaScript process backend loads without native binaries. This verifies
the archive and wrapper on the test host; it does not establish that Homebrew
installation succeeds on another operating system.

The archive excludes `node_modules` and native binaries. Homebrew installs the
packaged files into `libexec` and creates `toris` with the Homebrew Node path.
It runs neither `npm install` nor a Rust build. The optional native npm packages
are unnecessary for this distribution. If required npm dependencies are added
later, the builder refuses to generate a standalone formula until that packaging
contract is revised.

## Publish the archive and tap

Commit the source changes and create the matching version tag. The release
workflow publishes the archive and `SHA256SUMS` to a public release of
`torisKR/toris-agent`. For `0.5.0`, the formula points to:

```text
https://github.com/torisKR/toris-agent/releases/download/v0.5.0/toris-agent-0.5.0.tgz
```

Verify the uploaded archive's SHA256 against the local `SHA256SUMS`. Preserve
the exact archive after publication: rebuilding or replacing it can invalidate
the checksum already committed to the tap.

The release workflow can create the public tap repository
`torisKR/homebrew-tools` and commit the generated `Formula/toris-agent.rb` after
the release asset is reachable. This step needs the separate repository secret
`HOMEBREW_TAP_TOKEN`: it must have write access to the tap and permission to
create a public repository for `torisKR` if the tap does not exist yet. Configure
the secret through GitHub repository settings, without placing its value in
source files or logs. The source repository's built-in `GITHUB_TOKEN` publishes
the release but cannot generally create or write another repository.

If the tap token is absent, the workflow publishes the GitHub Release and
fails the tap step with an explicit message that it was not created or updated.
Homebrew publication
remains incomplete until that secret is configured and the workflow is rerun,
or an authorized maintainer creates the public tap and commits the exact
generated formula manually. A 403 response stops publication rather than being
treated as a missing repository. An existing private tap also stops the step.
Do not maintain a placeholder checksum in this repository.

On a machine with Homebrew, verify the published tap:

```bash
brew tap torisKR/tools
brew install torisKR/tools/toris-agent
brew test torisKR/tools/toris-agent
toris --version
```

The formula's test initializes an isolated project and validates a deterministic
`--offline --dry-run` plan. No model account is required for the install test.
Homebrew installation targets supported macOS and Linux hosts. The release
workflow verifies installation on its macOS runner. Linux Homebrew installation
needs validation on an actual Linux Homebrew host; the JavaScript packaging
test alone does not establish that result. Windows users should use the npm
distribution rather than this tap.

## Workflow relationship

`.github/workflows/ci.yml` runs the JavaScript tests and npm package smoke checks
on Node 22 and 24. `.github/workflows/release.yml` publishes GitHub assets and the
Homebrew tap, with no npm publishing or native build. The full workflow succeeds
only when both the GitHub Release and tap publication complete.

Push a matching `v<version>` tag to start the release workflow. For a retry,
dispatch it with the existing tag as its `tag` input. Before publication it:

1. Checks that the tag matches `package.json` and the checked-out commit matches
   the remote tag in the public `torisKR/toris-agent` repository.
2. Runs lint, the complete JavaScript test suite, and the archive builder.
3. Installs and runs `brew test` on the generated formula in a disposable local
   tap on `macos-latest`. Only that test formula's URL becomes a `file://` URL;
   its checksum, install code, and test code are unchanged. The published
   formula retains the exact public GitHub Release URL.
4. Rechecks the source tag, creates or completes the GitHub Release, and downloads
   the public assets to compare them with the tested bytes.
5. Creates or updates the public tap when its separate token is available.

Existing draft releases are rejected because their assets are not public.
Existing assets are never overwritten. A retry must produce exactly the same
archive and checksum bytes as already published; a mismatch fails the release.
Use a new version for changed package contents. The workflow is serialized so
concurrent releases do not race to update the tap, and it refuses to replace a
newer formula with an older release.
