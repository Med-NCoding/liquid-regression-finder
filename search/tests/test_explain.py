"""Unit and real-worker tests for Stage 5 HTML byte-offset tag walker and trace explanation."""

from __future__ import annotations

import unittest
from pathlib import Path

from search.explain import build_explanation, find_sale_badge_opening_tags
from search.worker_client import WorkerClient

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEMO_DIR = REPO_ROOT / "fixtures" / "demo"


class ExplainTests(unittest.TestCase):
    def test_html_opening_tag_walker_ignores_decoys_and_tracks_utf8_bytes(self) -> None:
        html = (
            "<!-- <span data-regression-badge=\"sale\">Comment decoy</span> -->"
            "<!-->"
            "<script>const s = '<span data-regression-badge=\"sale\">JS</span>';</script>"
            "<style>/* <span data-regression-badge='sale'>CSS</span> */</style>"
            "<textarea><span data-regression-badge=\"sale\">TA</span></textarea>"
            "<title><span data-regression-badge=\"sale\">Title</span></title>"
            "<p>&lt;span data-regression-badge=\"sale\"&gt;Escaped&lt;/span&gt;</p>"
            "<div title='<span data-regression-badge=\"sale\">Attr decoy</span>'>a < b</div>"
            "<span data-regression-badge=\"other\" data-regression-badge=\"sale\">Dup</span>"
            "<span data-regression-badge=sale/>"
            "<p>Café €10 🔥</p>"
            "<SPAN hidden DATA-REGRESSION-BADGE = \"&#115;ale\" class=\"badge\">Sale</SPAN>"
        )
        tags = find_sale_badge_opening_tags(html)
        self.assertEqual(len(tags), 1)
        tag = tags[0]
        self.assertEqual(tag.tag_name, "span")
        raw_bytes = html.encode("utf-8")
        matched_slice = raw_bytes[tag.start_byte : tag.end_byte].decode("utf-8")
        self.assertEqual(
            matched_slice,
            '<SPAN hidden DATA-REGRESSION-BADGE = "&#115;ale" class="badge">',
        )

    def test_html_walker_handles_unquoted_and_first_duplicate_attribute(self) -> None:
        self.assertEqual(len(find_sale_badge_opening_tags('<span data-regression-badge=sale>x</span>')), 1)
        self.assertEqual(
            len(find_sale_badge_opening_tags('<span data-regression-badge="sale" data-regression-badge="other">x</span>')),
            1,
        )
        self.assertEqual(len(find_sale_badge_opening_tags('<span data-regression-badge="SALE">x</span>')), 0)

    def test_multi_emit_assembled_tag_attribution_and_ambiguity_fallback(self) -> None:
        # 1. Tag assembled from multiple emits inside a single governing branch.
        before_ok = (
            "{%- assign cls = 'badge' -%}\n"
            "{%- if product.available -%}\n"
            '<span class="{{ cls }}" data-regression-badge="sale">Sale</span>\n'
            "{%- endif -%}\n"
        )
        after_ok = (
            "{%- assign cls = 'badge' -%}\n"
            "{%- if product.available -%}\n"
            '<span class="{{ cls }}" data-regression-badge="sale">Sale</span>\n'
            "{%- endif -%}\n"
        )
        # Modify after so it does not emit on same condition (e.g., threshold mismatch)
        before_multi = (
            "{%- assign limit = 100 -%}\n"
            "{%- assign cls = 'badge' -%}\n"
            "{%- if product.price > limit -%}\n"
            '<span class="{{ cls }}" data-regression-badge="sale">Sale</span>\n'
            "{%- endif -%}\n"
        )
        after_multi = (
            "{%- assign limit = 500 -%}\n"
            "{%- assign cls = 'badge' -%}\n"
            "{%- if product.price > limit -%}\n"
            '<span class="{{ cls }}" data-regression-badge="sale">Sale</span>\n'
            "{%- endif -%}\n"
        )
        fixture = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [{"id": "v1", "price": 200, "compare_at_price": None, "available": True}],
        }
        with WorkerClient(cwd=REPO_ROOT) as client:
            client.compile(before_multi, after_multi, observer="sale_badge")
            pair = client.render_pair(fixture, engine="custom", trace=True)
            exp = build_explanation(before_multi, after_multi, pair["before"], pair["after"])
            self.assertEqual(exp["kind"], "aligned_change")
            self.assertEqual(exp["before"]["line"], 3)
            self.assertEqual(exp["after"]["line"], 3)
            # Verify the tag really was assembled from multiple emit events!
            emits = [e for e in pair["before"]["events"] if e["data"]["kind"] == "emit"]
            self.assertGreaterEqual(len(emits), 3)

            # 2. Nested inner branch inside governing outer branch shares outer chain.
            before_nested = (
                "{%- assign limit = 100 -%}\n"
                "{%- if product.price > limit -%}\n"
                '<span class="{% if product.available %}avail{% endif %}" data-regression-badge="sale">Sale</span>\n'
                "{%- endif -%}\n"
            )
            after_nested = (
                "{%- assign limit = 500 -%}\n"
                "{%- if product.price > limit -%}\n"
                '<span class="{% if product.available %}avail{% endif %}" data-regression-badge="sale">Sale</span>\n'
                "{%- endif -%}\n"
            )
            client.compile(before_nested, after_nested, observer="sale_badge")
            pair_nested = client.render_pair(fixture, engine="custom", trace=True)
            exp_nested = build_explanation(before_nested, after_nested, pair_nested["before"], pair_nested["after"])
            self.assertEqual(exp_nested["kind"], "aligned_change")
            self.assertEqual(exp_nested["before"]["line"], 2)
            self.assertEqual(exp_nested["after"]["line"], 2)

            # 3. Conflicting/disjoint emits across two independent branches -> undetermined!
            before_disjoint = (
                "{%- if product.available -%}<span {%- endif -%}"
                "{%- if product.price > 0 -%} data-regression-badge=\"sale\">Sale</span>{%- endif -%}"
            )
            after_empty = ""
            client.compile(before_disjoint, after_empty, observer="sale_badge")
            pair_disjoint = client.render_pair(fixture, engine="custom", trace=True)
            exp_disjoint = build_explanation(before_disjoint, after_empty, pair_disjoint["before"], pair_disjoint["after"])
            self.assertEqual(exp_disjoint["kind"], "undetermined")
            self.assertIsNone(exp_disjoint["before"])
            self.assertIsNone(exp_disjoint["after"])

            # 4. Two badge tags in emitting HTML -> undetermined!
            before_two = (
                "{%- if product.available -%}"
                '<span data-regression-badge="sale">1</span>'
                '<span data-regression-badge="sale">2</span>'
                "{%- endif -%}"
            )
            client.compile(before_two, after_empty, observer="sale_badge")
            pair_two = client.render_pair(fixture, engine="custom", trace=True)
            exp_two = build_explanation(before_two, after_empty, pair_two["before"], pair_two["after"])
            self.assertEqual(exp_two["kind"], "undetermined")
            self.assertIsNone(exp_two["before"])
            self.assertIsNone(exp_two["after"])

    def test_aligned_change_inside_loop_with_binder_rename_and_variant_id_matching(self) -> None:
        before_src = (
            "{%- assign min_p = 150 -%}\n"
            "{%- for v in product.variants -%}\n"
            "  {%- if v.price > min_p -%}\n"
            '<span data-regression-badge="sale">Sale</span>\n'
            "  {%- endif -%}\n"
            "{%- endfor -%}\n"
        )
        after_src = (
            "{%- assign min_p = 500 -%}\n"
            "{%- for item in product.variants -%}\n"
            "  {%- if item.price > min_p -%}\n"
            '<span data-regression-badge="sale">Sale</span>\n'
            "  {%- endif -%}\n"
            "{%- endfor -%}\n"
        )
        fixture = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 50, "compare_at_price": None, "available": False},
                {"id": "v2", "price": 200, "compare_at_price": None, "available": False},
            ],
        }
        with WorkerClient(cwd=REPO_ROOT) as client:
            client.compile(before_src, after_src, observer="sale_badge")
            pair = client.render_pair(fixture, engine="custom", trace=True)
        exp = build_explanation(before_src, after_src, pair["before"], pair["after"])
        self.assertEqual(exp["kind"], "aligned_change")
        self.assertEqual(exp["before"]["line"], 3)
        self.assertEqual(exp["after"]["line"], 3)
        # Must align on v2 (where before evaluated true and after evaluated false), not v1!
        before_ev = pair["before"]["events"][exp["before"]["event_seq"]]
        after_ev = pair["after"]["events"][exp["after"]["event_seq"]]
        self.assertEqual(before_ev["scope"][0]["variant_id"], "v2")
        self.assertEqual(after_ev["scope"][0]["variant_id"], "v2")
        self.assertTrue(before_ev["data"]["condition"])
        self.assertFalse(after_ev["data"]["condition"])
        self.assertIn('variant_id="v2"', exp["summary"])
        self.assertTrue(exp["summary"].startswith("Aligned change:"))

    def test_diff_disambiguation_vs_genuine_ambiguity(self) -> None:
        # Two identical conditionals on non-emitting side, disambiguated by surrounding diff context!
        before_src = (
            "<!-- header block -->\n"
            "{%- assign min_p = 100 -%}\n"
            "{%- if product.price > min_p -%}\n"
            '<span data-regression-badge="sale">Sale</span>\n'
            "{%- endif -%}\n"
        )
        after_disambig = (
            "<!-- unrelated block -->\n"
            "{%- assign min_p = 500 -%}\n"
            "{%- if product.price > min_p -%}\n"
            '<span data-regression-badge="sale">Other</span>\n'
            "{%- endif -%}\n"
            "<!-- header block -->\n"
            "{%- if product.price > min_p -%}\n"
            '<span data-regression-badge="sale">Sale</span>\n'
            "{%- endif -%}\n"
        )
        fixture = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [{"id": "v1", "price": 200, "compare_at_price": None, "available": True}],
        }
        with WorkerClient(cwd=REPO_ROOT) as client:
            client.compile(before_src, after_disambig, observer="sale_badge")
            pair = client.render_pair(fixture, engine="custom", trace=True)
            exp = build_explanation(before_src, after_disambig, pair["before"], pair["after"])
            self.assertEqual(exp["kind"], "aligned_change")
            self.assertEqual(exp["before"]["line"], 3)
            self.assertEqual(exp["after"]["line"], 7)

            # Genuinely ambiguous: two completely identical blocks with identical surrounding lines.
            before_plain = (
                "{%- assign min_p = 100 -%}\n"
                "{%- if product.price > min_p -%}\n"
                '<span data-regression-badge="sale">Sale</span>\n'
                "{%- endif -%}\n"
            )
            after_ambig = (
                "{%- assign min_p = 500 -%}\n"
                "{%- if product.price > min_p -%}\n"
                '<span data-regression-badge="sale">Sale</span>\n'
                "{%- endif -%}\n"
                "{%- if product.price > min_p -%}\n"
                '<span data-regression-badge="sale">Sale</span>\n'
                "{%- endif -%}\n"
            )
            client.compile(before_plain, after_ambig, observer="sale_badge")
            pair_ambig = client.render_pair(fixture, engine="custom", trace=True)
            exp_ambig = build_explanation(before_plain, after_ambig, pair_ambig["before"], pair_ambig["after"])
            self.assertEqual(exp_ambig["kind"], "undetermined")

    def test_structural_change_on_demo_before_only_and_after_only(self) -> None:
        before_src = (DEMO_DIR / "before.liquid").read_text(encoding="utf-8")
        after_src = (DEMO_DIR / "after.liquid").read_text(encoding="utf-8")

        before_only_fixture = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 0, "compare_at_price": 0, "available": False},
                {"id": "v2", "price": 0, "compare_at_price": 1, "available": False},
            ],
        }
        after_only_fixture = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 100, "compare_at_price": None, "available": True},
                {"id": "v2", "price": 500, "compare_at_price": 400, "available": True},
            ],
        }

        with WorkerClient(cwd=REPO_ROOT) as client:
            client.compile(before_src, after_src, observer="sale_badge")

            pair1 = client.render_pair(before_only_fixture, engine="custom", trace=True)
            exp1 = build_explanation(before_src, after_src, pair1["before"], pair1["after"])
            self.assertEqual(exp1["kind"], "structural_change")
            self.assertEqual(exp1["before"]["line"], 3)
            self.assertEqual(exp1["after"]["line"], 1)
            b_ev = pair1["before"]["events"][exp1["before"]["event_seq"]]
            a_ev = pair1["after"]["events"][exp1["after"]["event_seq"]]
            self.assertEqual(b_ev["data"]["kind"], "branch")
            self.assertEqual(b_ev["scope"][0]["variant_id"], "v2")
            self.assertEqual(a_ev["data"]["kind"], "branch")
            self.assertTrue(exp1["summary"].startswith("Structural change:"))
            self.assertIn('variant_id="v2"', exp1["summary"])
            self.assertIn("variant.compare_at_price=1", exp1["summary"])
            self.assertIn("variant.price=0", exp1["summary"])
            self.assertIn("line 7", exp1["summary"])
            self.assertIn("on_sale", exp1["summary"])
            self.assertIn("product.compare_at_price=0", exp1["summary"])
            self.assertIn("product.price=0", exp1["summary"])

            pair2 = client.render_pair(after_only_fixture, engine="custom", trace=True)
            self.assertFalse(pair2["before"]["observed"])
            self.assertTrue(pair2["after"]["observed"])
            exp2 = build_explanation(before_src, after_src, pair2["before"], pair2["after"])
            self.assertEqual(exp2["kind"], "structural_change")
            self.assertEqual(exp2["before"]["line"], 3)
            self.assertEqual(exp2["after"]["line"], 1)

    def test_ambiguous_non_emitting_branches_and_unconditional_badge_return_undetermined(self) -> None:
        fixture = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [{"id": "v1", "price": 100, "compare_at_price": 200, "available": False}],
        }
        before_single = (
            "{%- if product.compare_at_price > product.price -%}\n"
            '<span data-regression-badge="sale">Sale</span>\n'
            "{%- endif -%}\n"
        )
        after_two_unrelated = (
            "{%- if product.available -%}<span>Avail</span>{%- endif -%}\n"
            "{%- if product.price > 500 -%}<span>Expensive</span>{%- endif -%}\n"
        )
        after_two_badge_branches = (
            "{%- if product.available -%}<span data-regression-badge=\"sale\">A</span>{%- endif -%}\n"
            "{%- if product.price > 500 -%}<span data-regression-badge=\"sale\">B</span>{%- endif -%}\n"
        )
        before_unconditional = '<span data-regression-badge="sale">Always</span>'

        with WorkerClient(cwd=REPO_ROOT) as client:
            client.compile(before_single, after_two_unrelated, observer="sale_badge")
            pair1 = client.render_pair(fixture, engine="custom", trace=True)
            exp1 = build_explanation(before_single, after_two_unrelated, pair1["before"], pair1["after"])
            self.assertEqual(exp1["kind"], "undetermined")
            self.assertIsNone(exp1["after"])

            client.compile(before_single, after_two_badge_branches, observer="sale_badge")
            pair2 = client.render_pair(fixture, engine="custom", trace=True)
            exp2 = build_explanation(before_single, after_two_badge_branches, pair2["before"], pair2["after"])
            self.assertEqual(exp2["kind"], "undetermined")
            self.assertIsNone(exp2["after"])

            client.compile(before_unconditional, after_two_unrelated, observer="sale_badge")
            pair3 = client.render_pair(fixture, engine="custom", trace=True)
            exp3 = build_explanation(before_unconditional, after_two_unrelated, pair3["before"], pair3["after"])
            self.assertEqual(exp3["kind"], "undetermined")
            self.assertIsNone(exp3["before"])
            self.assertIsNone(exp3["after"])


if __name__ == "__main__":
    unittest.main()
