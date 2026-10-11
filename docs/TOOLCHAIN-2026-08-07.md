# B0 — toolchain, session of 2026-08-07

Status: **✅ B0 DONE.** Windows native was probed and abandoned; the toolchain lives in
WSL and is proven by a real build. Everything below is machine state, not project state.

## ✅ The working toolchain — WSL, Ubuntu 24.04.4 LTS

Distro `Ubuntu-24.04`, 16 cores / 11 GB. WSL 2.7.11.0, kernel 6.18.33.2.

| | |
|---|---|
| rustc / cargo | 1.97.1 |
| solana-cli | 3.1.10 |
| anchor-cli | 1.1.2 (via avm) |
| platform-tools | v1.52 + v2.3.3 in `~/.cache/solana` |

**Pass evidence** — [wsl-bootstrap.sh](wsl-bootstrap.sh) built `~/anchor-probe` and emitted
**both** required artifacts:

- `target/deploy/anchor_probe.so` — 146,776 bytes
- `target/idl/anchor_probe.json` — 2,849 bytes, `"spec": "0.1.0"`, discriminators present

That IDL header is the Anchor 0.30+ format, which is the format `trident-idl-spec` reads —
so the remaining Trident unknown now leans favorable, though still unproven.

`sudo` in this distro **requires a password**, so the bootstrap's apt step is conditional:
it checks each package with `dpkg-query` and escalates only if something is missing. Every
later step is per-user and needs no root.

The probe is disposable. Delete `~/anchor-probe` whenever.

## ✅ The sale workspace — scaffolded and building

**`~/antirugdex/sale`** inside WSL (`\\wsl$\Ubuntu-24.04\home\<user>\antirugdex\sale` from
Windows). Created with `anchor init sale --no-install --no-git`. Verified:

- `target/deploy/sale.so` — 146,744 bytes
- `target/idl/sale.json` — 2,841 bytes
- **`cargo test` passes: 2 passed, 0 failed.** `test_initialize` is a real **LiteSVM**
  (`v0.10.0`) integration test executing the program, 0.13s. GAMEPLAN §6.6's chosen test
  stack works out of the box with no wiring.

This is empty scaffolding — Anchor's counter template, not sale logic. §6 starts from here.

`target/deploy/sale-keypair.json` is the generated **program keypair** (mode 600). It is
the program's on-chain identity. Anchor's `.gitignore` covers `target/`, so the repo
created below does **not** protect it — it still exists in exactly one place.

> ✅ **Under git as of 2026-08-08.** `git init` was run in place inside
> `~/antirugdex/sale` — not by copying the tree to Windows, which would have created a
> second copy to drift. Initial commit `ee8e0eb`, 29 files. The Windows-side TypeScript
> tooling at `antirugdex` is still not under version control.
>
> ⚠️ **A local repo is not a backup.** `wsl --unregister` or a WSL reset still deletes
> `~/antirugdex/sale` and its `.git` outright — no recycle bin. A remote, or a copy of the
> bundle somewhere else, is what makes it survivable. The tree is reachable from Windows
> Explorer at `\\wsl$\Ubuntu-24.04\home\<user>\antirugdex\sale`.

Cosmetic: every `wsl.exe` call prints `cannot translate 'D:\Ollama'` — WSL inheriting a
Windows PATH entry that does not resolve. Not a build error.

## Decision — 2026-08-07 (superseded by the above; kept for the reasoning)

Native Windows was probed properly and lost: two workarounds and one hard block (below),
plus `solana-verify` needing Docker needing WSL2 anyway for GAMEPLAN §6.3's verifiable
build. **Option A.** WSL repair is a user action and is the next thing to happen.

Windows side has been **restored and cleaned up**:

- `active_release` junction repointed to **Solana 4.1.1** — matches STATUS.md again
- the `cargo.exe` copy is **deleted**
- Rust, avm, anchor-cli and the User PATH entry are **kept** (harmless; `cargo install
  solana-verify` may want them later)
- ⚠️ `install\config.yml` was destroyed by `agave-install` and **not** restored, so
  `agave-install` needs a re-init if ever used. Different file from
  `~/.config/solana/cli/config.yml` — `solana config` is unaffected.

---

## What is installed and working

| Thing | Version | Where |
|---|---|---|
| Rust (rustup, MSVC host) | 1.97.1 stable | `%USERPROFILE%\.cargo\bin` |
| Rust (pinned by Anchor scaffold) | 1.89.0 | `.rustup\toolchains\1.89.0-x86_64-pc-windows-msvc` |
| avm | 1.1.2 | `.cargo\bin\avm.exe` |
| anchor-cli | **1.1.2** (0.31.1 also installed) | `.avm\bin`, copied to `.cargo\bin` |
| MSVC C++ tools + Windows SDK | VS 2026 Pro, SDK 10.0.26100 | preexisting |
| Solana CLI | 3.1.10 **and** 4.1.1, both on disk | see junction note |

`%USERPROFILE%\.cargo\bin` was added to the **User** PATH.

`anchor init` **succeeds**. `anchor build` **fails** — see the blocker.

---

## The one root cause: unprivileged symlink creation

Windows refuses `CreateSymbolicLink` to non-admin users unless **Developer Mode** is on.
Error everywhere: `A required privilege is not held by the client. (os error 1314)`.

Three separate tools in this stack hit it:

1. **`avm use`** — wants a `cargo-bin` symlink. Falls back to copying. *Harmless.*
2. **`agave-install`** — invoked automatically by `anchor` (see below). **Not harmless.**
3. **`cargo-build-sbf`** — installing platform-tools. **This is the hard blocker.**
   Fails before downloading anything; `~/.cache/solana` stays empty.

> Note: `cargo-build-sbf --version` prints a platform-tools version (`v1.54` on 4.1.1,
> `v1.52` on 3.1.10) **whether or not it is installed.** It is the version wanted, not
> the version present. Do not read it as "already installed" — that was misread once.

---

## Trap 1 — `anchor` deletes your Solana install

Every `anchor` invocation resolves a *recommended* Solana version and tries to activate it
through `agave-install`:

- anchor 1.1.2 → wants Solana **3.1.10**
- anchor 0.31.1 → wants Solana **2.1.0** (so downgrading Anchor is not an escape)

On Windows that activation **removes `~/.local/share/solana/install/active_release` and
then fails to recreate it**, because the replacement is a symlink. Net effect: your
`solana`, `spl-token`, `cargo-build-sbf` and `agave-install` commands all vanish from
PATH. This happened **twice** during this session, from nothing more than `anchor --version`.

`config.yml` in the install root is also destroyed and was not restored.

### The fix, and it needs no privileges

A **directory junction** does what the symlink was for and unprivileged users may create
them. Point `active_release` at whichever release Anchor wants, and it stops trying:

```powershell
$root='%USERPROFILE%\.local\share\solana\install'
if (Test-Path "$root\active_release") { Remove-Item "$root\active_release" -Force }
New-Item -ItemType Junction -Path "$root\active_release" `
         -Target "$root\releases\3.1.10\solana-release"
```

Both releases are on disk and switching is instant:

| Want | Target |
|---|---|
| Solana 3.1.10 — keeps anchor 1.1.2 quiet | `releases\3.1.10\solana-release` |
| Solana 4.1.1 — the original | `releases\stable-6a8c724a9ed8f093127ef6066e0bcfb074193cc3\solana-release` |

**`active_release` was left pointing at 4.1.1** (restored at end of session). No project
script cares which it is: the TS tooling
talks to `@solana/web3.js` and never shells out to the CLI. `solana-keygen` is referenced
only in a comment in `src/00-keygen.ts`.

---

## Trap 2 — `anchor` hides `~/.cargo/bin` from its own children

`anchor` rewrites PATH for every process it spawns. On Windows the curated PATH includes
the Solana `active_release\bin` directory but **not** `~/.cargo/bin`, so:

```
Error: Failed to execute 'cargo metadata'
Caused by: program not found
```

...even though `cargo --version` works in the same shell. Ruled out by elimination: not a
missing `sh`, not the `CARGO` env var, not the `rust-toolchain.toml` pin.

**Workaround (since removed):** copying the rustup `cargo.exe` proxy to
`…\solana\install\active_release\bin\cargo.exe` fixed it — the proxy resolves by its own
filename, so a copy works, and `anchor init` succeeded immediately after. Deleted during
cleanup because the copy lives *inside* the junction target and silently breaks whenever
the junction moves. Recreate it only if the native path is ever revisited.

---

## The blocker, stated plainly

`anchor build` cannot install platform-tools without symlink privilege. Options:

**A. Repair WSL, build the program in Linux.** Needs elevation + probably a reboot — a
user action. `wsl --status` currently fails with
`Wsl/CallMsi/Install/REGDB_E_CLASSNOTREG`. This is the path Anchor's own docs point
Windows users at, and **`solana-verify` needs Docker**, which on this machine needs WSL2
— so GAMEPLAN §6.3's "ship a verifiable build" requires WSL eventually regardless.

**B. Enable Windows Developer Mode** (Settings → System → For developers). One toggle, no
reboot, grants unprivileged symlink creation. Unblocks platform-tools, `agave-install`
and `avm` at once. Leaves the verifiable-build requirement unsolved.

**C. One elevated run** to install platform-tools, then continue unelevated. Narrowest,
but repeats on every platform-tools bump, and any `agave-install` trigger still eats
`active_release`.

---

## When WSL comes up

[wsl-bootstrap.sh](wsl-bootstrap.sh) does the whole Linux side in one reviewed run:
system packages → Rust → Solana **3.1.10** (pinned to anchor 1.1.2's recommendation, so
anchor never tries to switch it) → avm → anchor 1.1.2 → a throwaway build in
`~/anchor-probe`. It is idempotent and never touches the project directory.

Its exit status **is** the B0 pass/fail: it requires `anchor build` to emit **both** a
`.so` and an IDL JSON, and fails loudly on a `.so` alone. Run it from inside WSL:

```bash
bash ../wsl-bootstrap.sh
```

## Not yet answered

- **Does `anchor build` emit an IDL on Windows?** Unknown — it never got past
  platform-tools. `.so` **and** `target/idl/*.json` is the pass condition; the TS client
  needs the IDL.
- **Trident vs Anchor version.** Mostly resolved. Trident 0.11.x drops honggfuzz for its
  own TridentSVM, so it is **not** Linux-only — that was the fear, and it was wrong.
  `trident-client` has **no `anchor-lang` dependency at all**: it reads the **Anchor IDL**
  through `trident-idl-spec` and derives instruction types from it. So the coupling is to
  the *IDL format*, not to crate versions. Requires Anchor ≥ 0.29. The only remaining
  question is whether its parser accepts an **Anchor 1.x** IDL (the format changed at
  0.30), and that can only be settled by pointing `trident init` at a real generated IDL.

Good news on the testing stack: `anchor init` on 1.1.2 scaffolds tests with
**litesvm 0.10** as a dev-dependency already — GAMEPLAN §6.6's choice, pre-wired.

---

## Scaffold location — decided, not yet done

`anchor init` must **not** run in `Desktop\antirugdex`. It writes `package.json`,
`tsconfig.json` and `.gitignore`, all of which already exist, and **this directory is not
a git repository** — there is no undo. The real scaffold goes in a fresh
`antirugdex\sale\`. The probe used for all of the above is disposable and lives in the
session scratchpad, not in the project.
