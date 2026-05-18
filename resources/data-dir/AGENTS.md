# pdx runtime directory note

This directory is the Pandora's Box runtime home used by `pdx`.
Prefer `pithos` and `pdx` CLI inspection over reading or editing runtime files directly unless explicitly asked.

- `agents.toml` and `templates/` here are bundle-owned canonical reference files and are overwritten on `pdx init` / `pdx open`.
- User-owned config lives in `$PDX_USER_DATA_DIR` or, by default, `$PDX_DATA_DIR/config`.
- Project-local overrides live in `<repo-root>/.pdx/`.

Do not treat this file as a customization surface.
