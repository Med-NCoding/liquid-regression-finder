export const DEMO_BEFORE_SOURCE =
  "{%- assign on_sale = false -%}\n" +
  "{%- for variant in product.variants -%}\n" +
  "  {%- if variant.compare_at_price != nil and variant.compare_at_price > variant.price -%}\n" +
  "    {%- assign on_sale = true -%}\n" +
  "  {%- endif -%}\n" +
  "{%- endfor -%}\n" +
  "{%- if on_sale -%}\n" +
  '<span class="badge" data-regression-badge="sale">Sale</span>\n' +
  "{%- endif -%}\n";

export const DEMO_AFTER_SOURCE =
  "{%- if product.compare_at_price != nil and product.compare_at_price > product.price -%}\n" +
  '<span class="badge" data-regression-badge="sale">Sale</span>\n' +
  "{%- endif -%}\n";
