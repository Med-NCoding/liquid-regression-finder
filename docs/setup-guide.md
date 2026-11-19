# Liquid Regression Finder — CLI Setup Guide

`liquid-regression-finder` runs as a local npm CLI inside your Shopify theme Git repository without requiring the Rails or React web stack.

## System Prerequisites

- **Git**: `git` available on `PATH`
- **Node.js**: `>= 18.0.0` (verified with `24.15.0`)
- **Python**: `>= 3.10` (`python3.11` recommended; macOS `/usr/bin/python3` `3.9` is rejected)
- **Ruby**: `>= 3.1` (`ruby@3.3` recommended; macOS `/usr/bin/ruby` `2.6.10` is rejected)
- **Bundler**: matching the compatible Ruby `>= 3.1` installation

### Installing Prerequisites

**macOS (Homebrew):**

```sh
brew install git node python@3.11 ruby@3.3
```

Make sure Homebrew's `python@3.11` and keg-only `ruby@3.3` bins are available (or let `liquid-regression-finder` auto-detect them at `/opt/homebrew/opt/ruby@3.3/bin` and `/opt/homebrew/opt/python@3.11/bin`):

```sh
export PATH="/opt/homebrew/opt/ruby@3.3/bin:/opt/homebrew/opt/python@3.11/bin:$PATH"
```

**Ubuntu / Debian:**

```sh
sudo apt-get update && sudo apt-get install -y git nodejs npm python3.11 ruby-full build-essential
```

## Install in a Theme Repository

Install from npm or a packed tarball (`liquid-regression-finder-0.1.0.tgz`):

```sh
npm install -D liquid-regression-finder
# or from a local tarball:
npm install -D /path/to/liquid-regression-finder-0.1.0.tgz
```

Initialize the locked Ruby gem cache and verify both render engines:

```sh
npx liquid-regression-finder setup
```

`setup` checks `git`, `node`, `python`, `ruby`, and `bundler`, installs the locked `engine/Gemfile.lock` gems (`liquid 5.14.0`, `nokogiri`, `json_schemer`, `regexp_parser`) into a versioned user cache (`~/.cache/liquid-regression-finder/gems/v<pkg>-ruby<abi>-<lockSha12>` or `$LRF_CACHE_DIR`), and runs an end-to-end smoke check across both the custom interpreter and official `liquid 5.14.0`. `node_modules/` is never mutated.

## Theme Configuration

1. Copy `node_modules/liquid-regression-finder/liquid-regression.example.json` to `liquid-regression.json` at the root of your Git repository:

   ```json
   {
     "snippet_path": "snippets/card-product.liquid",
     "observer": "sale_badge",
     "seed": 0,
     "budget": {
       "search_pairs": 256,
       "shrink_pairs": 128
     },
     "watch_budget": {
       "search_pairs": 32,
       "shrink_pairs": 16
     }
   }
   ```

2. Ignore generated replay artifacts in your theme's `.gitignore`:

   ```gitignore
   .liquid-regression/
   ```

3. Optionally add npm scripts to your theme's `package.json`:

   ```json
   {
     "scripts": {
       "liquid:watch": "liquid-regression-finder watch",
       "liquid:check": "liquid-regression-finder check --base-ref HEAD"
     }
   }
   ```

## Daily Commands

- **Watch on save** (budget `32` search / `16` shrink by default):

  ```sh
  npx liquid-regression-finder watch
  ```

- **One-off check** against a Git baseline (`HEAD`, branch, tag, or commit SHA):

  ```sh
  npx liquid-regression-finder check --base-ref HEAD
  ```

- **Deterministic replay** of a saved finding:

  ```sh
  npx liquid-regression-finder replay .liquid-regression/result.json
  ```

## Environment Overrides

- `LRF_CACHE_DIR`: Override the user gem cache root (default: `~/.cache/liquid-regression-finder`).
- `LRF_GEM_CACHE`: Directory of pre-downloaded `.gem` files for offline `bundle install --local` during `setup`.
- `LRF_PYTHON`: Explicit path to Python `>= 3.10`.
- `LRF_RUBY`: Explicit path to Ruby `>= 3.1`.
- `LRF_RUBY_BUNDLE`: Explicit path to Bundler compatible with the selected Ruby.
