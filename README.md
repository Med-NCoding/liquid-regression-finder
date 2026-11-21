# liquid-regression-finder

A command-line tool that checks whether an edit to a Shopify Liquid snippet changes what shoppers see.

It compares the old version of a snippet (from Git) with your edited version, renders both against generated test products, and reports any product where the two versions give a different result. When it finds one, it shrinks the product to a small JSON fixture you can replay.

The current version checks one thing: whether the sale badge is shown or hidden.

## Why

Product cards behave differently depending on variants, prices, compare-at prices, and availability. Testing a few products by hand can miss a case that only shows up for one combination, such as a product with one discounted variant and one variant with no compare-at price.

## Requirements

- Node.js
- Python 3
- Ruby with Bundler

The Shopify Liquid gem (`liquid` 5.14.0) is installed into a per-user cache the first time the tool runs.

## Usage

Run the tool from the root of your theme repository. It watches your snippet and compares your working tree against `HEAD` each time you save.

```bash
npx liquid-regression-finder
```

To re-check a saved result:

```bash
npx liquid-regression-finder replay .liquid-regression/result.json
```

### Mark the badge

The tool looks for an element with `data-regression-badge="sale"`. Add it to the badge in your snippet:

```liquid
<span class="badge" data-regression-badge="sale">Sale</span>
```

## How it works

1. **Get both versions.** Reads the original snippet from Git and the edited snippet from your working tree.
2. **Generate products.** Starts with boundary cases (prices of 0, equal prices, missing compare-at prices, sold-out variants), then tries other combinations. Product-level fields like `price` and `compare_at_price` are calculated from the variants, the same way Shopify calculates them.
3. **Render both versions.** Renders each product with the old and new snippet using the official Liquid gem.
4. **Compare.** Checks whether the sale badge appears in one render but not the other.
5. **Shrink.** If a difference is found, removes variants and simplifies prices while the difference still happens.
6. **Save the result.** Writes `.liquid-regression/result.json`.

## Project structure

```
cli/      Node.js CLI: file watching, Git, process handling (no third-party dependencies)
search/   Python: product generation and shrinking (standard library only)
engine/   Ruby: renders snippets with the Shopify liquid gem
```

## Output

`.liquid-regression/result.json` contains:

- the minimized product fixture
- SHA-256 hashes of both snippet versions, so replay fails if either snippet has changed
- the rendered HTML from both versions
- a short explanation of the difference

## Exit codes

- `0`: no difference found within the search budget
- non-zero: a difference was found

## Example

The baseline snippet shows the badge if any variant has a compare-at price higher than its price. The edited snippet checks `product.compare_at_price > product.price` instead.

The tool finds a product like this:

| Variant | Price | Compare-at price |
|---|---|---|
| Small | $20 | none |
| Medium | $20 | $30 |

The baseline shows the badge because Medium is discounted. The edited version hides it because `product.compare_at_price` is the lowest compare-at price across variants.

## Limitations

- "No difference found" means none was found within the search budget. It does not prove the edit is safe.
- Only the sale badge is checked.
- The badge element must have the `data-regression-badge="sale"` attribute.
- The open-source Liquid gem does not include all Shopify-specific objects, filters, and tags, so results can differ from a live store for snippets that use them.
- Works on one snippet at a time. Snippets loaded with `render` or `include` are not followed.
- Needs Node.js, Python, and Ruby installed.

## Roadmap

- Test against real regressions from the Dawn theme's history
- GitHub Action that posts results on pull requests
- More checks, such as the sold-out badge and price text
- Show which condition evaluated differently and the values it used

## License

MIT
