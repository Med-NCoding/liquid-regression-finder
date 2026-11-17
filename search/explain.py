"""HTML badge byte-offset attribution, trace resolution, and cross-version explanation."""

from __future__ import annotations

import difflib
import html as html_lib
import json
import re
from dataclasses import dataclass
from typing import Any

_ASCII_WS_BYTES = frozenset(b" \t\n\f\r")
_ATTR_NAME_STOP_BYTES = frozenset(b" \t\n\f\r/=>")
_RAW_TEXT_TAGS = frozenset({"script", "style", "textarea", "title"})

_TAG_TOKEN_RE = re.compile(rb"\{%-?\s*(.*?)\s*-?%\}", re.DOTALL)
_FOR_HEADER_RE = re.compile(r"^for\s+([a-zA-Z_][a-zA-Z0-9_-]*)\s+in\s+(.+)$", re.DOTALL)
_ASSIGN_TAG_RE = re.compile(r"^assign\s+([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(.+)$", re.DOTALL)
_IDENT_SCAN_RE = re.compile(r"[a-zA-Z_][a-zA-Z0-9_-]*")


@dataclass(frozen=True)
class HtmlTagSpan:
    """UTF-8 byte span and effective attributes of a matched HTML opening tag."""

    tag_name: str
    start_byte: int
    end_byte: int
    attrs: dict[str, str]


BadgeTagMatch = HtmlTagSpan


@dataclass(frozen=True)
class _ParsedTag:
    start_byte: int
    end_byte: int
    keyword: str
    markup: str


@dataclass(frozen=True)
class _ParsedArm:
    tag_start_byte: int
    tag_keyword: str
    body_start_byte: int
    body_end_byte: int
    ancestry: tuple[tuple[str, str], ...]
    for_binders: tuple[tuple[str, str], ...]
    assigned_vars: tuple[str, ...]
    direct_badge: bool


@dataclass(frozen=True)
class _SourceIndex:
    arms_by_start: dict[int, _ParsedArm]
    tag_keyword_by_start: dict[int, str]
    for_binders_by_start: dict[int, tuple[tuple[str, str], ...]]
    ancestry_by_start: dict[int, tuple[tuple[str, str], ...]]
    badge_relevant_starts: frozenset[int]
    direct_badge_starts: frozenset[int]
    has_liquid_tags: bool


@dataclass(frozen=True)
class _ResolvedBranch:
    event: dict[str, Any]
    line: int
    seq: int
    expression: str
    condition: bool
    taken: bool
    variant_id: str | None
    loop_context: tuple[tuple[str, str | None, int | None], ...]
    lookups: tuple[tuple[str, Any], ...]
    comparisons: tuple[tuple[str, Any, Any, bool], ...]
    fingerprint: str
    ancestry: tuple[tuple[str, str], ...]
    gate_line: int | None
    gate_expression: str | None
    assign_line: int | None
    assign_var: str | None
    assign_value: Any


def _is_ascii_alpha(byte: int) -> bool:
    return (65 <= byte <= 90) or (97 <= byte <= 122)


def _find_raw_text_end(html_bytes: bytes, start_pos: int, tag_name: str) -> int:
    """Advance past raw-text/RCDATA element content until its matching closing tag."""
    n = len(html_bytes)
    target = tag_name.encode("ascii")
    tlen = len(target)
    scan = start_pos
    while scan < n:
        idx = html_bytes.find(b"</", scan)
        if idx == -1:
            return n
        name_start = idx + 2
        name_end = name_start + tlen
        if name_end <= n and html_bytes[name_start:name_end].lower() == target:
            if name_end == n or html_bytes[name_end] in _ASCII_WS_BYTES or html_bytes[name_end] in (0x2F, 0x3E):
                gt = html_bytes.find(b">", name_end)
                return gt + 1 if gt != -1 else n
        scan = idx + 2
    return n


def _skip_end_tag(html_bytes: bytes, lt_pos: int) -> int:
    n = len(html_bytes)
    cur = lt_pos + 2
    quote: int | None = None
    while cur < n:
        b = html_bytes[cur]
        if quote is not None:
            if b == quote:
                quote = None
        else:
            if b in (0x22, 0x27):
                quote = b
            elif b == 0x3E:
                return cur + 1
        cur += 1
    return n


def find_sale_badge_opening_tags(html_text: str) -> list[HtmlTagSpan]:
    """Walk rendered HTML UTF-8 bytes and return every opening tag with data-regression-badge='sale'."""
    html_bytes = html_text.encode("utf-8")
    n = len(html_bytes)
    pos = 0
    matches: list[HtmlTagSpan] = []

    while pos < n:
        lt = html_bytes.find(b"<", pos)
        if lt == -1 or lt + 1 >= n:
            break

        next_byte = html_bytes[lt + 1]

        # Comment: <!-- ... --> (including HTML5 abrupt closes <!--> and <!--->)
        if html_bytes[lt : lt + 4] == b"<!--":
            if lt + 4 < n and html_bytes[lt + 4] == 0x3E:
                pos = lt + 5
                continue
            if html_bytes[lt : lt + 6] == b"<!--->":
                pos = lt + 6
                continue
            end_comment = html_bytes.find(b"-->", lt + 4)
            pos = end_comment + 3 if end_comment != -1 else n
            continue

        # End tag: </...>
        if next_byte == 0x2F:
            pos = _skip_end_tag(html_bytes, lt)
            continue

        # DOCTYPE / bogus comment / processing instruction: <!...> or <?...>
        if next_byte in (0x21, 0x3F):
            gt = html_bytes.find(b">", lt + 2)
            pos = gt + 1 if gt != -1 else n
            continue

        # Opening tag: <[A-Za-z]...
        if not _is_ascii_alpha(next_byte):
            pos = lt + 1
            continue

        cur = lt + 1
        while cur < n and html_bytes[cur] not in _ASCII_WS_BYTES and html_bytes[cur] not in (0x2F, 0x3E):
            cur += 1
        tag_name = html_bytes[lt + 1 : cur].decode("utf-8", errors="replace").lower()

        attrs: dict[str, str] = {}
        closed_gt = False
        tag_end = n

        while cur < n:
            while cur < n and (html_bytes[cur] in _ASCII_WS_BYTES or html_bytes[cur] == 0x2F):
                cur += 1
            if cur >= n:
                break
            if html_bytes[cur] == 0x3E:
                closed_gt = True
                tag_end = cur + 1
                cur += 1
                break

            attr_start = cur
            while cur < n and html_bytes[cur] not in _ATTR_NAME_STOP_BYTES:
                cur += 1
            attr_name = html_bytes[attr_start:cur].decode("utf-8", errors="replace").lower()

            while cur < n and html_bytes[cur] in _ASCII_WS_BYTES:
                cur += 1

            attr_val = ""
            if cur < n and html_bytes[cur] == 0x3D:
                cur += 1
                while cur < n and html_bytes[cur] in _ASCII_WS_BYTES:
                    cur += 1
                if cur < n:
                    if html_bytes[cur] in (0x22, 0x27):
                        quote = html_bytes[cur]
                        cur += 1
                        val_start = cur
                        close_q = html_bytes.find(quote, cur)
                        if close_q == -1:
                            cur = n
                            break
                        raw_val = html_bytes[val_start:close_q].decode("utf-8", errors="replace")
                        attr_val = html_lib.unescape(raw_val)
                        cur = close_q + 1
                    else:
                        val_start = cur
                        while cur < n and html_bytes[cur] not in _ASCII_WS_BYTES and html_bytes[cur] != 0x3E:
                            cur += 1
                        raw_val = html_bytes[val_start:cur].decode("utf-8", errors="replace")
                        attr_val = html_lib.unescape(raw_val)

            # In HTML5, first attribute occurrence wins on duplicate names.
            if attr_name and attr_name not in attrs:
                attrs[attr_name] = attr_val

        if not closed_gt:
            break

        if attrs.get("data-regression-badge") == "sale":
            matches.append(
                HtmlTagSpan(
                    tag_name=tag_name,
                    start_byte=lt,
                    end_byte=tag_end,
                    attrs=attrs,
                )
            )

        if tag_name in _RAW_TEXT_TAGS:
            pos = _find_raw_text_end(html_bytes, tag_end, tag_name)
        else:
            pos = tag_end

    return matches


find_sale_badge_tags = find_sale_badge_opening_tags


def _has_badge_markup_hint(source_slice: str) -> bool:
    """Check whether a Liquid arm body slice contains a sale badge tag (including dynamic attribute values)."""
    if find_sale_badge_opening_tags(source_slice):
        return True
    lowered = source_slice.lower()
    if "data-regression-badge" not in lowered:
        return False
    return bool(re.search(r"data-regression-badge\s*=\s*(?:['\"]sale['\"]|['\"]\{\{|\{\{|sale\b)", lowered))


def _scan_liquid_source(source: str | None) -> _SourceIndex:
    if not source:
        return _SourceIndex({}, {}, {}, {}, frozenset(), frozenset(), False)

    source_bytes = source.encode("utf-8")
    tags: list[_ParsedTag] = []
    for match in _TAG_TOKEN_RE.finditer(source_bytes):
        inner = match.group(1).decode("utf-8", errors="replace").strip()
        if not inner:
            continue
        parts = inner.split(None, 1)
        keyword = parts[0]
        markup = parts[1] if len(parts) > 1 else ""
        tags.append(
            _ParsedTag(
                start_byte=match.start(),
                end_byte=match.end(),
                keyword=keyword,
                markup=markup,
            )
        )

    if not tags:
        return _SourceIndex({}, {}, {}, {}, frozenset(), frozenset(), False)

    tag_keyword_by_start: dict[int, str] = {}
    for_binders_by_start: dict[int, tuple[tuple[str, str], ...]] = {}
    ancestry_by_start: dict[int, tuple[tuple[str, str], ...]] = {}
    arms: list[_ParsedArm] = []
    stack: list[dict[str, Any]] = []
    closed_arms_raw: list[dict[str, Any]] = []

    def current_ancestry() -> tuple[tuple[str, str], ...]:
        items: list[tuple[str, str]] = []
        for entry in stack:
            if entry["kind"] == "for":
                items.append(("for", entry["collection"]))
            else:
                arm_kw = entry["arm_keyword"]
                arm_type = "unless_arm" if arm_kw == "unless" else ("else_arm" if arm_kw == "else" else "if_arm")
                items.append(("conditional", arm_type))
        return tuple(items)

    def current_for_binders() -> tuple[tuple[str, str], ...]:
        return tuple((entry["binder"], entry["collection"]) for entry in stack if entry["kind"] == "for")

    def add_assigned_var(var_name: str) -> None:
        for entry in stack:
            if entry["kind"] in ("if", "unless"):
                entry["assigned_vars"].append(var_name)

    for tag in tags:
        kw = tag.keyword
        tag_keyword_by_start[tag.start_byte] = kw

        if kw in ("if", "unless"):
            arm_type = "unless_arm" if kw == "unless" else "if_arm"
            anc = current_ancestry() + (("conditional", arm_type),)
            binders = current_for_binders()
            ancestry_by_start[tag.start_byte] = anc
            for_binders_by_start[tag.start_byte] = binders
            stack.append(
                {
                    "kind": kw,
                    "arm_keyword": kw,
                    "tag_start_byte": tag.start_byte,
                    "body_start_byte": tag.end_byte,
                    "ancestry": anc,
                    "for_binders": binders,
                    "assigned_vars": [],
                }
            )
        elif kw == "elsif":
            prev_kind = "if"
            if stack and stack[-1]["kind"] in ("if", "unless"):
                prev = stack.pop()
                prev_kind = prev["kind"]
                closed_arms_raw.append({**prev, "body_end_byte": tag.start_byte})
            anc = current_ancestry() + (("conditional", "if_arm"),)
            binders = current_for_binders()
            ancestry_by_start[tag.start_byte] = anc
            for_binders_by_start[tag.start_byte] = binders
            stack.append(
                {
                    "kind": prev_kind,
                    "arm_keyword": "elsif",
                    "tag_start_byte": tag.start_byte,
                    "body_start_byte": tag.end_byte,
                    "ancestry": anc,
                    "for_binders": binders,
                    "assigned_vars": [],
                }
            )
        elif kw == "else":
            if stack and stack[-1]["kind"] == "for":
                ancestry_by_start[tag.start_byte] = current_ancestry() + (("for_else", ""),)
                for_binders_by_start[tag.start_byte] = current_for_binders()
                stack[-1]["else_start_byte"] = tag.start_byte
                stack[-1]["else_body_start"] = tag.end_byte
            elif stack and stack[-1]["kind"] in ("if", "unless"):
                prev = stack.pop()
                closed_arms_raw.append({**prev, "body_end_byte": tag.start_byte})
                anc = current_ancestry() + (("conditional", "else_arm"),)
                binders = current_for_binders()
                ancestry_by_start[tag.start_byte] = anc
                for_binders_by_start[tag.start_byte] = binders
                stack.append(
                    {
                        "kind": prev["kind"],
                        "arm_keyword": "else",
                        "tag_start_byte": tag.start_byte,
                        "body_start_byte": tag.end_byte,
                        "ancestry": anc,
                        "for_binders": binders,
                        "assigned_vars": [],
                    }
                )
        elif kw in ("endif", "endunless"):
            if stack and stack[-1]["kind"] in ("if", "unless"):
                prev = stack.pop()
                closed_arms_raw.append({**prev, "body_end_byte": tag.start_byte})
        elif kw == "for":
            m = _FOR_HEADER_RE.match(f"for {tag.markup}".strip())
            binder = m.group(1) if m else ""
            coll = " ".join(m.group(2).split()) if m else ""
            ancestry_by_start[tag.start_byte] = current_ancestry()
            for_binders_by_start[tag.start_byte] = current_for_binders()
            stack.append(
                {
                    "kind": "for",
                    "binder": binder,
                    "collection": coll,
                    "tag_start_byte": tag.start_byte,
                    "body_start_byte": tag.end_byte,
                }
            )
        elif kw == "endfor":
            if stack and stack[-1]["kind"] == "for":
                stack.pop()
        elif kw == "assign":
            m = _ASSIGN_TAG_RE.match(f"assign {tag.markup}".strip())
            if m:
                add_assigned_var(m.group(1))

    arms_by_start: dict[int, _ParsedArm] = {}
    direct_badge_starts: set[int] = set()
    for raw in closed_arms_raw:
        body_slice = source_bytes[raw["body_start_byte"] : raw["body_end_byte"]].decode("utf-8", errors="replace")
        has_direct = _has_badge_markup_hint(body_slice)
        if has_direct:
            direct_badge_starts.add(raw["tag_start_byte"])
        arm = _ParsedArm(
            tag_start_byte=raw["tag_start_byte"],
            tag_keyword=raw["arm_keyword"],
            body_start_byte=raw["body_start_byte"],
            body_end_byte=raw["body_end_byte"],
            ancestry=raw["ancestry"],
            for_binders=raw["for_binders"],
            assigned_vars=tuple(raw["assigned_vars"]),
            direct_badge=has_direct,
        )
        arms_by_start[arm.tag_start_byte] = arm
        arms.append(arm)

    badge_relevant = set(direct_badge_starts)
    changed = True
    while changed:
        changed = False
        relevant_vars: set[str] = set()
        for start in badge_relevant:
            arm_tag = next((t for t in tags if t.start_byte == start), None)
            if arm_tag is not None:
                for ident in _IDENT_SCAN_RE.findall(arm_tag.markup):
                    relevant_vars.add(ident)
        for arm in arms:
            if arm.tag_start_byte not in badge_relevant:
                if any(var in relevant_vars for var in arm.assigned_vars):
                    badge_relevant.add(arm.tag_start_byte)
                    changed = True

    return _SourceIndex(
        arms_by_start=arms_by_start,
        tag_keyword_by_start=tag_keyword_by_start,
        for_binders_by_start=for_binders_by_start,
        ancestry_by_start=ancestry_by_start,
        badge_relevant_starts=frozenset(badge_relevant),
        direct_badge_starts=frozenset(direct_badge_starts),
        has_liquid_tags=True,
    )


def _normalize_expression(expr: str, for_binders: tuple[tuple[str, str], ...]) -> str:
    """Normalize whitespace, null->nil, and enclosing loop binder aliases outside string literals."""
    binder_map = {binder: f"$loop({coll})" for binder, coll in for_binders if binder}
    out: list[str] = []
    i = 0
    n = len(expr)

    while i < n:
        ch = expr[i]
        if ch.isspace():
            if out and out[-1] != " ":
                out.append(" ")
            i += 1
            continue
        if ch in ('"', "'"):
            quote = ch
            j = i + 1
            while j < n and expr[j] != quote:
                j += 1
            if j < n:
                j += 1
            out.append(expr[i:j])
            i = j
            continue
        if ch.isalpha() or ch == "_":
            j = i + 1
            while j < n and (expr[j].isalnum() or expr[j] in ("_", "-", "?")):
                j += 1
            ident = expr[i:j]
            prev_nonspace = out[-1] if out and out[-1] != " " else (out[-2] if len(out) >= 2 else "")
            if prev_nonspace != ".":
                if ident == "null":
                    ident = "nil"
                elif ident in binder_map:
                    ident = binder_map[ident]
            out.append(ident)
            i = j
            continue
        out.append(ch)
        i += 1

    return "".join(out).strip()


def _ancestry_from_node_id(
    node_id: str,
    loop_collections: dict[str, str],
    tag_keyword: str | None = None,
) -> tuple[tuple[str, str], ...]:
    parts = node_id.split(".")
    ancestry: list[tuple[str, str]] = []
    prefix_parts: list[str] = []
    for idx, part in enumerate(parts):
        prefix_parts.append(part)
        if part.endswith(":for"):
            loop_id = ".".join(prefix_parts)
            coll = loop_collections.get(loop_id, "")
            ancestry.append(("for", coll))
        elif ":conditional" in part and idx + 1 < len(parts):
            next_part = parts[idx + 1]
            if next_part.startswith("else:"):
                ancestry.append(("conditional", "else_arm"))
            elif next_part.startswith("a"):
                arm_type = tag_keyword if (idx + 2 == len(parts) and tag_keyword) else "if_arm"
                ancestry.append(("conditional", arm_type))
    return tuple(ancestry)


def _common_branch_prefix(chains: list[list[int]]) -> list[int]:
    if not chains:
        return []
    prefix = list(chains[0])
    for chain in chains[1:]:
        limit = min(len(prefix), len(chain))
        idx = 0
        while idx < limit and prefix[idx] == chain[idx]:
            idx += 1
        prefix = prefix[:idx]
        if not prefix:
            return []
    return prefix


def _collect_loop_collections(events: list[dict[str, Any]]) -> dict[str, str]:
    collections: dict[str, str] = {}
    for ev in events:
        if ev["data"]["kind"] == "lookup" and ev["node_id"].endswith(".coll:lookup"):
            loop_id = ev["node_id"][: -len(".coll:lookup")]
            collections[loop_id] = ev["data"]["path"]
    return collections


def _collect_branch_operands(
    events: list[dict[str, Any]],
    branch_idx: int,
) -> tuple[tuple[tuple[str, Any], ...], tuple[tuple[str, Any, Any, bool], ...]]:
    branch_ev = events[branch_idx]
    node_id = branch_ev["node_id"]
    if not node_id.endswith(":branch"):
        return (), ()

    cond_prefix = node_id[: -len(":branch")] + ".cond"
    scope = branch_ev["scope"]
    collected: list[dict[str, Any]] = []

    idx = branch_idx - 1
    while idx >= 0:
        ev = events[idx]
        if ev["scope"] != scope or not ev["node_id"].startswith(cond_prefix):
            break
        if ev["data"]["kind"] not in ("lookup", "comparison"):
            break
        collected.append(ev)
        idx -= 1

    collected.reverse()
    lookups_dict: dict[str, Any] = {}
    comparisons: list[tuple[str, Any, Any, bool]] = []
    for ev in collected:
        data = ev["data"]
        if data["kind"] == "lookup":
            lookups_dict[data["path"]] = data["value"]
        elif data["kind"] == "comparison":
            comparisons.append((data["op"], data["left"], data["right"], data["result"]))

    return tuple(lookups_dict.items()), tuple(comparisons)


def _resolve_else_arm_branch(events: list[dict[str, Any]], branch_idx: int) -> int:
    """When the innermost active branch is a conditional `else`, resolve its negated preceding arm if unambiguous."""
    ev = events[branch_idx]
    node_id = ev["node_id"]
    if not node_id.endswith(".else:branch") or ":conditional.else:branch" not in node_id:
        return branch_idx

    cond_base = node_id[: -len(".else:branch")]
    scope = ev["scope"]
    sibling_arms: list[int] = []
    idx = branch_idx - 1
    while idx >= 0:
        prev = events[idx]
        if prev["scope"] == scope and prev["data"]["kind"] == "branch":
            prev_id = prev["node_id"]
            if prev_id.startswith(cond_base + ".a") and prev_id.endswith(":branch"):
                sibling_arms.append(idx)
            elif not prev_id.startswith(cond_base + "."):
                break
        idx -= 1

    if len(sibling_arms) == 1:
        return sibling_arms[0]
    return branch_idx


def _find_enclosing_branch_for_assignment(
    events: list[dict[str, Any]],
    assign_idx: int,
) -> int | None:
    assign_ev = events[assign_idx]
    assign_node_id = assign_ev["node_id"]
    assign_scope = assign_ev["scope"]

    for idx in range(assign_idx - 1, -1, -1):
        cand = events[idx]
        if cand["data"]["kind"] != "branch" or cand["data"]["taken"] is not True:
            continue
        cand_scope = cand["scope"]
        if len(cand_scope) > len(assign_scope) or assign_scope[: len(cand_scope)] != cand_scope:
            continue
        cand_id = cand["node_id"]
        if not cand_id.endswith(":branch"):
            continue
        arm_prefix = cand_id[: -len(":branch")]
        if assign_node_id.startswith(arm_prefix + ".b") or assign_node_id.startswith(arm_prefix + ".e"):
            return idx
    return None


def _build_resolved_branch(
    events: list[dict[str, Any]],
    branch_idx: int,
    source_index: _SourceIndex,
    loop_collections: dict[str, str],
    *,
    gate_line: int | None = None,
    gate_expression: str | None = None,
    assign_line: int | None = None,
    assign_var: str | None = None,
    assign_value: Any = None,
) -> _ResolvedBranch:
    ev = events[branch_idx]
    start_byte = ev["span"]["start_byte"]
    tag_kw = source_index.tag_keyword_by_start.get(start_byte)
    arm_type = "unless_arm" if tag_kw == "unless" else ("else_arm" if tag_kw == "else" else "if_arm")

    if start_byte in source_index.ancestry_by_start:
        ancestry = source_index.ancestry_by_start[start_byte]
    else:
        ancestry = _ancestry_from_node_id(ev["node_id"], loop_collections, tag_keyword=arm_type)

    for_binders = source_index.for_binders_by_start.get(start_byte, ())
    lookups, comparisons = _collect_branch_operands(events, branch_idx)
    fingerprint = _normalize_expression(ev["data"]["expression"], for_binders)

    scope = ev["scope"]
    variant_ids = [f["variant_id"] for f in scope if f.get("variant_id") is not None]
    variant_id = variant_ids[-1] if variant_ids else None
    loop_ctx = tuple(
        (
            loop_collections.get(f["loop_id"], ""),
            f["variant_id"],
            None if f["variant_id"] is not None else f["iteration"],
        )
        for f in scope
    )

    return _ResolvedBranch(
        event=ev,
        line=ev["span"]["line"],
        seq=ev["seq"],
        expression=ev["data"]["expression"],
        condition=ev["data"]["condition"],
        taken=ev["data"]["taken"],
        variant_id=variant_id,
        loop_context=loop_ctx,
        lookups=lookups,
        comparisons=comparisons,
        fingerprint=fingerprint,
        ancestry=ancestry,
        gate_line=gate_line,
        gate_expression=gate_expression,
        assign_line=assign_line,
        assign_var=assign_var,
        assign_value=assign_value,
    )


def _resolve_decisive_emitting_branches(
    events: list[dict[str, Any]],
    common_chain: list[int],
    source_index: _SourceIndex,
    loop_collections: dict[str, str],
) -> tuple[_ResolvedBranch, list[_ResolvedBranch]]:
    """Resolve innermost governing branch (following assigned flag variables) plus any outer branches."""
    seq_to_idx = {ev["seq"]: idx for idx, ev in enumerate(events)}
    innermost_idx = seq_to_idx[common_chain[-1]]
    effective_idx = _resolve_else_arm_branch(events, innermost_idx)
    outer_indices = [seq_to_idx[s] for s in common_chain[:-1]]

    gate_line: int | None = None
    gate_expression: str | None = None
    assign_line: int | None = None
    assign_var: str | None = None
    assign_value: Any = None

    cur_idx = effective_idx
    visited_assignments: set[int] = set()
    for _ in range(4):
        lookups, comparisons = _collect_branch_operands(events, cur_idx)
        if len(lookups) != 1 or comparisons:
            break
        var_name, read_val = lookups[0]
        if "." in var_name:
            break

        matching_assign_idx: int | None = None
        fallback_assign_idx: int | None = None
        for idx in range(cur_idx - 1, -1, -1):
            cand = events[idx]
            if cand["data"]["kind"] == "assignment" and cand["data"]["name"] == var_name:
                if fallback_assign_idx is None:
                    fallback_assign_idx = idx
                if cand["data"]["value"] == read_val:
                    matching_assign_idx = idx
                    break

        assign_idx = matching_assign_idx if matching_assign_idx is not None else fallback_assign_idx
        if assign_idx is None or assign_idx in visited_assignments:
            break
        visited_assignments.add(assign_idx)

        enclosing_idx = _find_enclosing_branch_for_assignment(events, assign_idx)
        if enclosing_idx is None:
            break

        if gate_line is None:
            gate_ev = events[cur_idx]
            gate_line = gate_ev["span"]["line"]
            gate_expression = gate_ev["data"]["expression"]
            assign_ev = events[assign_idx]
            assign_line = assign_ev["span"]["line"]
            assign_var = assign_ev["data"]["name"]
            assign_value = assign_ev["data"]["value"]
        cur_idx = enclosing_idx

    decisive = _build_resolved_branch(
        events,
        cur_idx,
        source_index,
        loop_collections,
        gate_line=gate_line,
        gate_expression=gate_expression,
        assign_line=assign_line,
        assign_var=assign_var,
        assign_value=assign_value,
    )
    outers = [_build_resolved_branch(events, idx, source_index, loop_collections) for idx in reversed(outer_indices)]
    return decisive, outers


def _context_window_lines(lines: list[str], one_based_line: int, radius: int = 2) -> list[str]:
    idx0 = one_based_line - 1
    lo = max(0, idx0 - radius)
    hi = min(len(lines), idx0 + radius + 1)
    return [lines[i].strip() for i in range(lo, hi) if i != idx0 and lines[i].strip()]


def _disambiguate_by_source_diff(
    emit_branch: _ResolvedBranch,
    candidates: list[_ResolvedBranch],
    *,
    emit_is_before: bool,
    before_source: str,
    after_source: str,
) -> _ResolvedBranch | None:
    before_lines = before_source.splitlines()
    after_lines = after_source.splitlines()
    emit_lines = before_lines if emit_is_before else after_lines
    non_emit_lines = after_lines if emit_is_before else before_lines

    emit_ctx = _context_window_lines(emit_lines, emit_branch.line, radius=3)

    # Compare symmetric surrounding exact unchanged lines (avoiding greedy first-match or modified-line bias).
    scored: list[tuple[int, _ResolvedBranch]] = []
    for cand in candidates:
        cand_ctx = _context_window_lines(non_emit_lines, cand.line, radius=3)
        sm = difflib.SequenceMatcher(None, emit_ctx, cand_ctx)
        matched_lines = sum(block.size for block in sm.get_matching_blocks())
        scored.append((matched_lines, cand))

    max_score = max(score for score, _ in scored)
    if max_score == 0:
        return None
    best = [cand for score, cand in scored if score == max_score]
    return best[0] if len(best) == 1 else None


def _format_json_val(val: Any) -> str:
    if val is None:
        return "nil"
    if isinstance(val, bool):
        return "true" if val else "false"
    return json.dumps(val, ensure_ascii=False)


def _format_operands(branch: _ResolvedBranch) -> str:
    if branch.lookups:
        parts = [f"{path}={_format_json_val(val)}" for path, val in branch.lookups]
        return ", ".join(parts)
    if branch.comparisons:
        parts = [
            f"{_format_json_val(left)} {op} {_format_json_val(right)} ({_format_json_val(res)})"
            for op, left, right, res in branch.comparisons
        ]
        return ", ".join(parts)
    return f"condition={_format_json_val(branch.condition)}"


def _select_non_emitting_structural_branch(
    non_emit_events: list[dict[str, Any]],
    non_emit_source_index: _SourceIndex,
    non_emit_loop_collections: dict[str, str],
    emit_branch: _ResolvedBranch,
) -> _ResolvedBranch | None:
    resolved_all: list[_ResolvedBranch] = []
    for idx, ev in enumerate(non_emit_events):
        if ev["data"]["kind"] == "branch":
            resolved_all.append(
                _build_resolved_branch(non_emit_events, idx, non_emit_source_index, non_emit_loop_collections)
            )

    untaken = [b for b in resolved_all if b.taken is False]

    # Handle case where `if X ... else <badge>` executed `taken == True` and blocked the `else` branch.
    if not untaken and non_emit_source_index.has_liquid_tags:
        blocking_else_arms: list[_ResolvedBranch] = []
        for b in resolved_all:
            if b.taken is True:
                node_id = b.event["node_id"]
                if ".a" in node_id and node_id.endswith(":branch"):
                    else_arms = [
                        arm
                        for arm in non_emit_source_index.arms_by_start.values()
                        if arm.tag_keyword == "else"
                        and arm.direct_badge
                        and arm.ancestry[:-1] == b.ancestry[:-1]
                    ]
                    if len(else_arms) == 1:
                        blocking_else_arms.append(b)
        if len(blocking_else_arms) == 1:
            return blocking_else_arms[0]
        return None

    if not untaken:
        return None

    if non_emit_source_index.has_liquid_tags:
        direct_badge_untaken = [
            b for b in untaken if b.event["span"]["start_byte"] in non_emit_source_index.direct_badge_starts
        ]
        # If there is a single direct badge gate that reads a flag variable (e.g. `if on_sale`)
        # and all inner transitive flag-setting evaluations come from ONE AST branch, unwrap to it!
        if len(direct_badge_untaken) == 1:
            gate = direct_badge_untaken[0]
            if len(gate.lookups) == 1 and not gate.comparisons and "." not in gate.lookups[0][0]:
                inner_relevant = [
                    b
                    for b in untaken
                    if b.event["span"]["start_byte"] in non_emit_source_index.badge_relevant_starts
                    and b.event["span"]["start_byte"] not in non_emit_source_index.direct_badge_starts
                ]
                distinct_ast_starts = {b.event["span"]["start_byte"] for b in inner_relevant}
                if len(distinct_ast_starts) == 1:
                    chosen = max(inner_relevant, key=lambda b: (len(b.comparisons), b.seq))
                    return _ResolvedBranch(
                        event=chosen.event,
                        line=chosen.line,
                        seq=chosen.seq,
                        expression=chosen.expression,
                        condition=chosen.condition,
                        taken=chosen.taken,
                        variant_id=chosen.variant_id,
                        loop_context=chosen.loop_context,
                        lookups=chosen.lookups,
                        comparisons=chosen.comparisons,
                        fingerprint=chosen.fingerprint,
                        ancestry=chosen.ancestry,
                        gate_line=gate.line,
                        gate_expression=gate.expression,
                        assign_line=None,
                        assign_var=gate.lookups[0][0],
                        assign_value=gate.lookups[0][1],
                    )
            return gate

        if len(direct_badge_untaken) > 1:
            if emit_branch.variant_id is not None:
                vid_matches = [b for b in direct_badge_untaken if b.variant_id == emit_branch.variant_id]
                if len(vid_matches) == 1:
                    return vid_matches[0]
            return None

        relevant_untaken = [
            b for b in untaken if b.event["span"]["start_byte"] in non_emit_source_index.badge_relevant_starts
        ]
        if len(relevant_untaken) == 1:
            return relevant_untaken[0]
        if len(relevant_untaken) > 1:
            if emit_branch.variant_id is not None:
                vid_matches = [b for b in relevant_untaken if b.variant_id == emit_branch.variant_id]
                if len(vid_matches) == 1:
                    return vid_matches[0]
            return None
        return None

    return untaken[0] if len(untaken) == 1 else None


def _describe_branch_side(label: str, b: _ResolvedBranch) -> str:
    subject = f'variant_id="{b.variant_id}"' if b.variant_id is not None else "product/context"
    ops = _format_operands(b)
    outcome = _format_json_val(b.taken)
    gate = ""
    if b.gate_line is not None:
        assign_note = (
            f" (if {b.assign_var}={_format_json_val(b.assign_value)}"
            + (f", assigned at line {b.assign_line}" if b.assign_line is not None else "")
            + ")"
            if b.assign_var is not None
            else f" (`{b.gate_expression}`)"
        )
        gate = f" via line {b.gate_line}{assign_note}"
    return f"{label} at line {b.line} in {subject}{gate} [{b.expression}] -> {outcome} ({ops})"


def build_explanation(
    before_source: str,
    after_source: str,
    before_result: dict[str, Any],
    after_result: dict[str, Any],
    *,
    observer: str = "sale_badge",
) -> dict[str, Any]:
    """Attribute the badge difference between `before_result` and `after_result` to trace anchors."""
    if observer != "sale_badge":
        return {
            "kind": "undetermined",
            "before": None,
            "after": None,
            "summary": f"Undetermined: unsupported observer {observer!r} for explanation attribution.",
        }

    if (
        before_result.get("status") != "ok"
        or after_result.get("status") != "ok"
        or before_result.get("observed") == after_result.get("observed")
    ):
        return {
            "kind": "undetermined",
            "before": None,
            "after": None,
            "summary": "Undetermined: renders do not show an unambiguous ok-status observer difference.",
        }

    emit_is_before = bool(before_result["observed"])
    emit_res = before_result if emit_is_before else after_result
    non_emit_res = after_result if emit_is_before else before_result
    emit_source = before_source if emit_is_before else after_source
    non_emit_source = after_source if emit_is_before else before_source

    emit_html = emit_res["html"] or ""
    emit_events = emit_res.get("events") or []
    non_emit_events = non_emit_res.get("events") or []

    badge_tags = find_sale_badge_opening_tags(emit_html)
    if len(badge_tags) != 1:
        return {
            "kind": "undetermined",
            "before": None,
            "after": None,
            "summary": (
                f"Undetermined: expected exactly 1 unambiguous sale badge opening tag on "
                f"{'before' if emit_is_before else 'after'}, found {len(badge_tags)}."
            ),
        }

    badge_tag = badge_tags[0]
    overlapping_emits = [
        ev
        for ev in emit_events
        if ev["data"]["kind"] == "emit"
        and ev["data"]["output_start_byte"] < badge_tag.end_byte
        and badge_tag.start_byte < ev["data"]["output_end_byte"]
    ]
    if not overlapping_emits:
        return {
            "kind": "undetermined",
            "before": None,
            "after": None,
            "summary": "Undetermined: no traced emit event overlaps the recognized sale badge opening tag.",
        }

    common_chain = _common_branch_prefix([ev["data"]["active_branch_seqs"] for ev in overlapping_emits])
    if not common_chain:
        return {
            "kind": "undetermined",
            "before": None,
            "after": None,
            "summary": (
                "Undetermined: overlapping emits for the sale badge opening tag lack a common "
                "governing branch chain."
            ),
        }

    emit_src_index = _scan_liquid_source(emit_source)
    non_emit_src_index = _scan_liquid_source(non_emit_source)
    emit_loop_colls = _collect_loop_collections(emit_events)
    non_emit_loop_colls = _collect_loop_collections(non_emit_events)

    decisive_emit, outer_emits = _resolve_decisive_emitting_branches(
        emit_events,
        common_chain,
        emit_src_index,
        emit_loop_colls,
    )

    non_emit_resolved_branches = [
        _build_resolved_branch(non_emit_events, idx, non_emit_src_index, non_emit_loop_colls)
        for idx, ev in enumerate(non_emit_events)
        if ev["data"]["kind"] == "branch"
    ]

    # 1. Try aligned_change across [decisive_emit] + outer_emits
    for eb in [decisive_emit, *outer_emits]:
        aligned_candidates = [
            nb
            for nb in non_emit_resolved_branches
            if nb.fingerprint == eb.fingerprint
            and nb.ancestry == eb.ancestry
            and nb.loop_context == eb.loop_context
            and (nb.condition != eb.condition or nb.taken != eb.taken)
        ]
        if not aligned_candidates:
            continue

        if len(aligned_candidates) == 1:
            matched_nb = aligned_candidates[0]
        else:
            matched_nb = _disambiguate_by_source_diff(
                eb,
                aligned_candidates,
                emit_is_before=emit_is_before,
                before_source=before_source,
                after_source=after_source,
            )

        if matched_nb is None:
            emit_anchor = {"line": eb.line, "event_seq": eb.seq}
            return {
                "kind": "undetermined",
                "before": emit_anchor if emit_is_before else None,
                "after": None if emit_is_before else emit_anchor,
                "summary": (
                    f"Undetermined: multiple ambiguous aligned branch candidates on "
                    f"{'after' if emit_is_before else 'before'} matching `{eb.expression}`."
                ),
            }

        before_branch = eb if emit_is_before else matched_nb
        after_branch = matched_nb if emit_is_before else eb
        return {
            "kind": "aligned_change",
            "before": {"line": before_branch.line, "event_seq": before_branch.seq},
            "after": {"line": after_branch.line, "event_seq": after_branch.seq},
            "summary": (
                f"Aligned change: on `{before_branch.expression}`: "
                f"{_describe_branch_side('before', before_branch)}; "
                f"{_describe_branch_side('after', after_branch)}."
            ),
        }

    # 2. Try structural_change
    non_emit_structural = _select_non_emitting_structural_branch(
        non_emit_events,
        non_emit_src_index,
        non_emit_loop_colls,
        decisive_emit,
    )
    if non_emit_structural is None:
        emit_anchor = {"line": decisive_emit.line, "event_seq": decisive_emit.seq}
        return {
            "kind": "undetermined",
            "before": emit_anchor if emit_is_before else None,
            "after": None if emit_is_before else emit_anchor,
            "summary": (
                f"Undetermined: attributed {'before' if emit_is_before else 'after'} line "
                f"{decisive_emit.line} (seq {decisive_emit.seq}), but alignment on "
                f"{'after' if emit_is_before else 'before'} is ambiguous."
            ),
        }

    before_branch = decisive_emit if emit_is_before else non_emit_structural
    after_branch = non_emit_structural if emit_is_before else decisive_emit

    return {
        "kind": "structural_change",
        "before": {"line": before_branch.line, "event_seq": before_branch.seq},
        "after": {"line": after_branch.line, "event_seq": after_branch.seq},
        "summary": (
            f"Structural change: {_describe_branch_side('before', before_branch)}; "
            f"{_describe_branch_side('after', after_branch)}."
        ),
    }
