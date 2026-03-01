PREFIX ?= /usr
DESTDIR ?=
INSTALL_DIR = $(DESTDIR)$(PREFIX)/share/cockpit/nspawn

.PHONY: all dist install rpm dev clean

all: dist

dist:
	npm ci
	npm run build
	cp src/index.html dist/
	cp src/manifest.json dist/

install: dist
	mkdir -p $(INSTALL_DIR)
	cp -r dist/* $(INSTALL_DIR)/

dev:
	mkdir -p dist
	cp src/index.html dist/
	cp src/manifest.json dist/
	npm run watch

rpm: dist
	rpmbuild -ba cockpit-nspawn.spec

clean:
	rm -rf dist node_modules
