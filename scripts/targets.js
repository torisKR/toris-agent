/**
 * The one place that knows which platforms get a prebuilt binary.
 *
 * Three things must agree or users silently lose the native module:
 *   1. `optionalDependencies` in package.json (what npm tries to install)
 *   2. the CI build matrix (what actually gets published)
 *   3. `platformTriple()` in src/native/index.js (what the loader asks for)
 *
 * A drift between 1 and 2 is the nasty one: npm treats a missing optional
 * dependency as success, so the failure is invisible — everyone just quietly
 * runs the JS fallback. test/targets.test.js pins 1 against this table.
 *
 * Platforms absent from this list are not broken; they get the pure-JS
 * fallback, which is correct on any POSIX system.
 */

export const NATIVE_SCOPE = '@toris-agent';

/**
 * @type {ReadonlyArray<{
 *   triple: string, rustTarget: string, os: string, cpu: string,
 *   libc?: string, runner: string, dylib: string,
 * }>}
 */
export const TARGETS = Object.freeze([
  {
    triple: 'darwin-arm64',
    rustTarget: 'aarch64-apple-darwin',
    os: 'darwin',
    cpu: 'arm64',
    runner: 'macos-14',
    dylib: 'libtoris_native.dylib',
  },
  {
    triple: 'darwin-x64',
    rustTarget: 'x86_64-apple-darwin',
    os: 'darwin',
    cpu: 'x64',
    runner: 'macos-13',
    dylib: 'libtoris_native.dylib',
  },
  {
    triple: 'linux-x64-gnu',
    rustTarget: 'x86_64-unknown-linux-gnu',
    os: 'linux',
    cpu: 'x64',
    libc: 'glibc',
    runner: 'ubuntu-22.04',
    dylib: 'libtoris_native.so',
  },
  {
    triple: 'linux-arm64-gnu',
    rustTarget: 'aarch64-unknown-linux-gnu',
    os: 'linux',
    cpu: 'arm64',
    libc: 'glibc',
    runner: 'ubuntu-22.04-arm',
    dylib: 'libtoris_native.so',
  },
  {
    triple: 'win32-x64-msvc',
    rustTarget: 'x86_64-pc-windows-msvc',
    os: 'win32',
    cpu: 'x64',
    runner: 'windows-2022',
    dylib: 'toris_native.dll',
  },
]);

/** @param {string} triple @returns {string} the npm package name for a prebuild */
export function packageNameFor(triple) {
  return `${NATIVE_SCOPE}/native-${triple}`;
}

/** @param {string} triple */
export function findTarget(triple) {
  return TARGETS.find((t) => t.triple === triple);
}

/**
 * The `optionalDependencies` block the root package.json must carry.
 * @param {string} version
 */
export function optionalDependenciesFor(version) {
  return Object.fromEntries(TARGETS.map((t) => [packageNameFor(t.triple), version]));
}
