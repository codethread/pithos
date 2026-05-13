HOME_BIN := $(HOME)/.local/bin
PDX_BIN_DIR ?= $(HOME_BIN)

.PHONY: local
local:
	pnpm install
	pnpm build
	mkdir -p $(HOME_BIN)
	ln -sf $(abspath packages/pithos/bin/pithos) $(HOME_BIN)/pithos
	ln -sf $(abspath packages/pdx/bin/pdx) $(HOME_BIN)/pdx
	ln -sf $(abspath packages/spawner/bin/pandora-spawn) $(HOME_BIN)/pandora-spawn

.PHONY: install
install:
	pnpm install
	pnpm build
	mkdir -p $(PDX_BIN_DIR)
	ln -sf $(abspath packages/pithos/bin/pithos) $(PDX_BIN_DIR)/pithos
	ln -sf $(abspath packages/pdx/bin/pdx) $(PDX_BIN_DIR)/pdx
	ln -sf $(abspath packages/spawner/bin/pandora-spawn) $(PDX_BIN_DIR)/pandora-spawn
