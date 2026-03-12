# Credits

cockpit-nspawn is built on the shoulders of several excellent open source projects.
We are grateful to their authors and contributors.

---

## Cockpit
**https://cockpit-project.org**
License: LGPL-2.1-or-later

The foundation this module is built on. Cockpit provides the web-based server management
interface, the JavaScript API for interacting with the host system, the build infrastructure
(pkg/lib), and the PatternFly integration. Without Cockpit, this module would not exist.

---

## PatternFly
**https://www.patternfly.org**
License: MIT

The design system used for all UI components — tables, modals, forms, alerts, buttons.
PatternFly is Red Hat's open source design system and provides a consistent, accessible,
and professional look and feel.

---

## React
**https://react.dev**
License: MIT

The JavaScript library for building the user interface. All components in cockpit-nspawn
are written as React functional components.

---

## xterm.js
**https://xtermjs.org**
License: MIT

The terminal emulator component used for the in-browser shell access to containers.
xterm.js provides a full-featured, performant terminal that runs entirely in the browser.

---

## esbuild
**https://esbuild.github.io**
License: MIT

The extremely fast JavaScript bundler and minifier used to build the production assets.
esbuild makes the build process nearly instantaneous compared to traditional bundlers.

---

## esbuild-sass-plugin
**https://github.com/glromeo/esbuild-sass-plugin**
License: MIT

esbuild plugin that handles SCSS compilation as part of the build pipeline.

---

## gettext-parser
**https://github.com/smhg/gettext-parser**
License: MIT

Used in the build pipeline to parse `.po` translation files and generate the JavaScript
locale bundles that power the multi-language support.

---

## cockpit-podman
**https://github.com/cockpit-project/cockpit-podman**
License: LGPL-2.1-or-later

The structural inspiration for cockpit-nspawn. The build system, esbuild configuration,
and overall project layout are modeled after cockpit-podman. It showed that a Cockpit
module for container management was both possible and practical.

---

## cockpit-starter-kit
**https://github.com/cockpit-project/starter-kit**
License: LGPL-2.1-or-later

The official template for Cockpit modules, used as a reference for project structure,
dark theme integration, and build conventions.

---

## Claude Code
**https://claude.ai/claude-code**
Anthropic — proprietary, free for personal use

The AI coding assistant used to design and implement cockpit-nspawn from the ground up.
The entire codebase — React components, build system, bootstrap logic, translations, RPM
packaging, and documentation — was developed in close collaboration with Claude Code.
This project would not exist without it, and we see no reason not to say so openly.

---

*If you believe your project should be listed here and is not, please open an issue.*
