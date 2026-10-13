#!/usr/bin/env bash
# Build this worktree incrementally, then atomically install a smoke-tested ompc.
set -euo pipefail

if [[ $# -gt 0 ]]; then
	if [[ $# -eq 1 && ( $1 == --help || $1 == -h ) ]]; then
		printf 'Usage: bash scripts/build-install-ompc.sh\nBuild this worktree using mise bun@1.4 and install ~/.local/bin/ompc.\n'
		exit 0
	fi
	printf 'build-install-ompc: no arguments supported (except --help)\n' >&2
	exit 1
fi

fail() {
	printf 'build-install-ompc: %s\n' "$*" >&2
	exit 1
}

[[ -n ${HOME:-} && $HOME == /* && -d $HOME ]] || fail 'HOME must name an existing absolute directory'
mise_bin=$(command -v mise) || fail 'mise is required on PATH'
[[ -f $mise_bin && -x $mise_bin ]] || fail 'mise must resolve to an executable file'
# Resolve a relative PATH entry before changing to the worktree root.
mise_bin=$(CDPATH='' cd -- "$(dirname -- "$mise_bin")" && printf '%s/%s' "$PWD" "$(basename -- "$mise_bin")")
repo_root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$repo_root"

# Keep existing mise/Cargo paths and caches, but prefer system tools to user ld wrappers.
export PATH="/usr/bin:/bin:${PATH:-}:$HOME/.cargo/bin"
# Inherited compiler/linker overrides can bypass PATH (including Rust wrappers).
# Scrub only this script's environment; never change Cargo or mise configuration.
for variable in $(compgen -v); do
	case "$variable" in
		RUSTUP_TOOLCHAIN|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC_LINKER|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CC|CXX|LD|AR|CFLAGS|CXXFLAGS|LDFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_BUILD_RUSTC_WRAPPER|CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER|CARGO_TARGET_*_LINKER|CARGO_TARGET_*_RUSTFLAGS|CC_*|CXX_*|LD_*|AR_*)
			unset "$variable"
			;;
	esac
done
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-4}
export OMP_NATIVE_BUILD_BACKEND=cargo
export OMP_NATIVE_CARGO_PROFILE=local

candidate=''
runtime_root=''
cleanup() {
	[[ -z $candidate ]] || rm -f -- "$candidate"
	[[ -z $runtime_root ]] || rm -rf -- "$runtime_root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '[1/5] Install locked dependencies in %s (reuse existing caches)\n' "$repo_root"
"$mise_bin" exec bun@1.4 -- bun install --frozen-lockfile
printf '[2/5] Build native addon incrementally (cargo/local, jobs=%s)\n' "$CARGO_BUILD_JOBS"
"$mise_bin" exec bun@1.4 cmake@4 -- bun run build:native
printf '[3/5] Build standalone executable\n'
"$mise_bin" exec bun@1.4 -- bun --cwd=packages/coding-agent run build

artifact="$repo_root/packages/coding-agent/dist/omp"
[[ -f $artifact && -x $artifact ]] || fail "missing executable build artifact: $artifact"
install_dir="$HOME/.local/bin"
target="$install_dir/ompc"
mkdir -p -- "$install_dir"
[[ ! -d $target ]] || fail "installation target is a directory: $target"
candidate=$(mktemp "$install_dir/.ompc-install.XXXXXX")
# Preserve the built executable's mode so the candidate can run before promotion.
cp --preserve=mode -- "$artifact" "$candidate"
runtime_root=$(mktemp -d "${TMPDIR:-/tmp}/ompc-smoke.XXXXXX")
mkdir -- "$runtime_root/home" "$runtime_root/tmp"
printf '[4/5] Check candidate --version and --smoke-test with isolated runtime environment\n'
(
	cd -- "$runtime_root"
	env -i HOME="$runtime_root/home" TMPDIR="$runtime_root/tmp" PATH=/usr/bin:/bin LANG=C.UTF-8 OMP_SKIP_SETUP=1 "$candidate" --version
	env -i HOME="$runtime_root/home" TMPDIR="$runtime_root/tmp" PATH=/usr/bin:/bin LANG=C.UTF-8 OMP_SKIP_SETUP=1 "$candidate" --smoke-test
)
printf '[5/5] Atomically install %s (leave omp untouched)\n' "$target"
chmod 755 -- "$candidate"
# -T also prevents a directory appearing after the earlier check from consuming it.
mv -fT -- "$candidate" "$target"
candidate=''
printf 'Installed %s\n' "$target"
