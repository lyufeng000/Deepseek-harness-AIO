# AIO profile seed

This directory is the version-controlled, privacy-filtered manifest for the AIO first-run profile.

The full offline `node_modules` tree is intentionally not committed to Git. It contains thousands of third-party files and should be built or distributed as a separately reviewed release asset.

For an offline release build, prepare a seed directory with this layout:

```text
profile-seed/
├── AGENTS.md
├── settings.yaml
└── profiles/web-desktop/
    ├── package.json
    ├── cordis.yml
    ├── cordis.patch.yml
    └── node_modules/
```

Then set:

```powershell
$env:DSH_PROFILE_SEED_DIR = 'D:\path\to\profile-seed'
```

`AGENTS.md` is the reviewed user-global instruction default. On a first run into an
empty `$DSH_HOME` it lands at `$DSH_HOME/AGENTS.md`, where the harness loads it ahead
of the project chain — a workspace's own `AGENTS.md`/`CLAUDE.md` is rendered after it
and wins on conflict, so existing projects keep their own rules. A non-empty
`$DSH_HOME` is never overwritten, so upgrades do not re-seed this file.

The release staging script rejects a seed that does not contain `profiles/web-desktop/node_modules`.
Machine-local pnpm state such as `.modules.yaml`, `.pnpm-workspace-state-v1.json`, and `.pnpm/lock.yaml` must not be included.
