# Pinned Toolchain & Dependency Versions

Recorded during Stage 1 bootstrap and extended in Stages 8–9; verified via `bin/check`.

## Language Runtimes

| Tool | Pinned Version | Version File | Executable Verified |
|---|---|---|---|
| Ruby | `3.3.13` | `.ruby-version` | `/opt/homebrew/opt/ruby@3.3/bin/ruby` |
| Bundler | `4.0.23` | `Gemfile.lock` (`BUNDLED WITH`) | `/opt/homebrew/opt/ruby@3.3/bin/bundle` |
| Python | `3.11.18` | `.python-version` | `/opt/homebrew/opt/python@3.11/bin/python3.11` |
| Node.js | `24.15.0` | `.node-version` | `/usr/local/bin/node` |
| npm | `11.12.1` | — | `/usr/local/bin/npm` |

## Root Ruby Gems (`Gemfile` / `Gemfile.lock`)

| Gem | Pinned / Locked Version | Notes |
|---|---|---|
| `liquid` | `5.14.0` | Satisfies `liquid-spec`'s `~> 5.13` requirement; reference renderer |
| `liquid-spec` | `2.0.0` @ SHA `84bf25e0edbca5f7e530574788b0f875ab331f50` | `https://github.com/Shopify/liquid-spec.git` |
| `nokogiri` | `1.19.7` | HTML fragment observer dependency (Stage 3+) |
| `minitest` | `5.27.0` | Pinned `~> 5.25` for Ruby/ActiveSupport 8 compatibility |
| `json_schemer` | `2.5.0` | JSON Schema Draft 2020-12 contract validation |
| `regexp_parser` | `2.12.0` | Pinned `~> 2.12.0` (`< 2.13` required by `json_schemer 2.5.0`) |
| `activesupport` | `8.1.4.1` | Transitive dependency of `liquid-spec` |
| `super_diff` | `0.19.0` | Transitive dependency of `liquid-spec` |

## Rails API Gems (`api/Gemfile` / `api/Gemfile.lock`)

| Gem | Pinned / Locked Version | Notes |
|---|---|---|
| `rails` | `8.1.4.1` | API-mode Rails 8 application (`config.load_defaults 8.1`, `api_only = true`) |
| `sqlite3` | `2.10.2` | SQLite3 Active Record adapter |
| `solid_queue` | `1.7.2` | Database-backed Active Job adapter (single-worker configuration) |
| `puma` | `8.1.2` | HTTP web server |
| `minitest` | `5.27.0` | API unit and integration test suite |
| `json_schemer` | `2.5.0` | Contract schema validation for `Finding`, `Stats`, `Diagnostic`, and `ComparisonJob` |
| `regexp_parser` | `2.12.0` | Pinned `~> 2.12.0` (`< 2.13` required by `json_schemer 2.5.0`) |

## Web Frontend Packages (`web/package.json` / `web/package-lock.json`)

| Package | Locked Version | Notes |
|---|---|---|
| `react` / `react-dom` | `19.3.1` | React 19 UI runtime |
| `react-router-dom` | `7.18.5` | Client-side routing (`/`, `/comparisons/:id`) |
| `typescript` | `5.9.3` | Strict TypeScript checking (`tsc --noEmit`) |
| `vite` | `7.3.8` | Frontend build & dev server with `/api` proxy |
| `@vitejs/plugin-react` | `4.7.0` | Vite React transform plugin |
| `vitest` | `3.2.7` | Unit & component test runner |
| `@testing-library/react` | `16.3.3` | React DOM testing utilities |
| `@testing-library/jest-dom` | `6.9.1` | DOM matchers |
| `jsdom` | `26.1.0` | Browser DOM test environment |
| `playwright-core` | `1.65.1` | Headless Chrome browser integration runner |

## Clean Checkout Install

```sh
./bin/setup
./bin/check stage-9
```

`bin/setup` configures Bundler locally (`vendor/bundle` and `api/vendor/bundle`, git-ignored), installs strictly from `Gemfile.lock` and `api/Gemfile.lock` (`BUNDLE_FROZEN=true bundle install`), prepares the SQLite databases in `api/`, and installs `web/` npm packages from `web/package-lock.json` (`npm ci`).
