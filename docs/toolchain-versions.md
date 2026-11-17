# Pinned Toolchain & Dependency Versions

Recorded during Stage 1 bootstrap and verified via `bin/check stage-1`.

## Language Runtimes

| Tool | Pinned Version | Version File | Executable Verified |
|---|---|---|---|
| Ruby | `3.3.13` | `.ruby-version` | `/opt/homebrew/opt/ruby@3.3/bin/ruby` |
| Bundler | `4.0.23` | `Gemfile.lock` (`BUNDLED WITH`) | `/opt/homebrew/opt/ruby@3.3/bin/bundle` |
| Python | `3.11.18` | `.python-version` | `/opt/homebrew/opt/python@3.11/bin/python3.11` |
| Node.js | `24.15.0` | `.node-version` | `/usr/local/bin/node` |
| npm | `11.12.1` | — | `/usr/local/bin/npm` |

## Ruby Gems (`Gemfile` / `Gemfile.lock`)

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

## Clean Checkout Install

```sh
./bin/setup
./bin/check stage-1
```

Both `bin/setup` and `bin/check` configure Bundler locally (`vendor/bundle`, git-ignored) and install strictly from `Gemfile.lock` (`BUNDLE_FROZEN=true bundle install`).
