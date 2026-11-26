# dt-ffmpeg (TypeScript). The frozen Python reference lives in reference/python and is not part of this gate.

NPM := npm

.PHONY: help setup typecheck lint test build verify doctor hooks release clean

help:
	@echo "dt-ffmpeg"
	@echo "  make setup      npm ci (locked install)"
	@echo "  make typecheck  tsc --noEmit"
	@echo "  make lint       eslint"
	@echo "  make test       vitest run"
	@echo "  make build      tsc to dist/"
	@echo "  make verify     typecheck + lint + test + build (the gate)"
	@echo "  make doctor     Node version and ffmpeg/ffprobe resolution (JSON)"
	@echo "  make hooks      install a git pre-push hook that runs make verify"
	@echo "  make release    archive of the tagged commit + .sha256 (needs tag v<version> on MAIN_REF)"
	@echo "  make clean      remove dist and caches"

setup:
	$(NPM) ci

typecheck:
	$(NPM) run typecheck

lint:
	$(NPM) run lint

test:
	$(NPM) test

build:
	$(NPM) run build

verify: typecheck lint test build

doctor:
	node scripts/doctor.mjs

hooks:
	@d="$$(git rev-parse --git-path hooks)"; mkdir -p "$$d"; \
	if [ -e "$$d/pre-push" ] && ! grep -q "make verify" "$$d/pre-push"; then \
	  echo "existing pre-push hook kept; add 'make verify' to it by hand" >&2; exit 1; fi; \
	printf '#!/bin/sh\nexec make verify\n' > "$$d/pre-push"; chmod +x "$$d/pre-push"; \
	echo "pre-push -> make verify ($$d)"

# Release: the archive is made from the tagged commit, which must be an ancestor of MAIN_REF (fetch it first;
# override MAIN_REF on hosts with another remote name). A lock directory lets one run at a time publish a version,
# so an existing archive is never overwritten. The archive and its .sha256 are written under a staging directory and
# only then moved into place (sha256 first, archive last), so an interrupted run never leaves a bare archive without
# its checksum; it can leave a checksum alone, which a rerun overwrites. A failed run can leave its staging
# directory behind. Releases live outside dist/, which `make clean` removes.
# The npm pack tarball of the first release (design SOW 3.5) is added with the first release; until then the
# source archive is the artifact.
VERSION := $(shell sed -n 's/^  "version": "\(.*\)",$$/\1/p' package.json | head -1)
ARCHIVE := releases/dt-ffmpeg-$(VERSION).tar.gz
MAIN_REF ?= upstream/main

release:
	@set -e; tag="v$(VERSION)"; \
	git rev-parse -q --verify "refs/tags/$$tag" >/dev/null || { echo "tag $$tag does not exist" >&2; exit 1; }; \
	commit=$$(git rev-list -n1 "$$tag"); \
	git merge-base --is-ancestor "$$commit" "$(MAIN_REF)" || { echo "$$tag ($$commit) is not on $(MAIN_REF)" >&2; exit 1; }; \
	tagged=$$(git show "$$commit:package.json" | sed -n 's/^  "version": "\(.*\)",$$/\1/p' | head -1); \
	test "$$tagged" = "$(VERSION)" || { echo "tagged package.json version $$tagged != $(VERSION)" >&2; exit 1; }; \
	git show "$$commit:CHANGELOG.md" | grep -q "^## \[$(VERSION)\]" || { echo "tagged CHANGELOG has no $(VERSION) entry" >&2; exit 1; }; \
	mkdir -p releases; lock="releases/.lock-$(VERSION)"; \
	mkdir "$$lock" 2>/dev/null || { echo "$$lock exists: another release is running, or one was killed" >&2; exit 1; }; \
	trap 'rmdir "$$lock"' EXIT; trap 'exit 1' HUP INT TERM; \
	test ! -e $(ARCHIVE) || { echo "$(ARCHIVE) exists; refusing to overwrite a release" >&2; exit 1; }; \
	stage=$$(mktemp -d releases/.stage.XXXXXX); \
	git archive --format=tar.gz --prefix=dt-ffmpeg-$(VERSION)/ -o "$$stage/$(notdir $(ARCHIVE))" "$$commit"; \
	(cd "$$stage" && shasum -a 256 $(notdir $(ARCHIVE)) > $(notdir $(ARCHIVE)).sha256); \
	mv "$$stage/$(notdir $(ARCHIVE)).sha256" "$$stage/$(notdir $(ARCHIVE))" releases/; rmdir "$$stage"; \
	echo "archived $$tag = $$commit"; cat $(ARCHIVE).sha256

clean:
	rm -rf dist coverage
