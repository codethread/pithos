HOME_BIN := $(HOME)/.local/bin

.PHONY: local
local:
	pnpm install
	pnpm build
	mkdir -p $(HOME_BIN)
	ln -sf $(abspath packages/pithos/bin/pithos) $(HOME_BIN)/pithos
	ln -sf $(abspath packages/pdx/bin/pdx) $(HOME_BIN)/pdx
	ln -sf $(abspath packages/spawner/bin/pandora-spawn) $(HOME_BIN)/pandora-spawn
