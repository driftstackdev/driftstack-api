"""The AI surface's docs say what the product does, not how it is built.

Every docstring on the agent-sessions resource is what ``help()`` and an IDE
show a customer, and the AI example is copied into their code, so that text
must never name internal infrastructure, internal ticket or work ids, or agent
names. Docstrings and string literals are read with :mod:`ast` and comments
with :mod:`tokenize`, so what is checked is exactly what the file says — not a
regex guess at where a comment starts.
"""

from __future__ import annotations

import ast
import io
import re
import tokenize
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
RESOURCE = PKG / "src" / "driftstack" / "resources" / "agent_sessions.py"
ERRORS = PKG / "src" / "driftstack" / "errors.py"
EXAMPLE = PKG / "examples" / "agent_chat.py"

INTERNAL: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bharness\b", re.I), 'infrastructure name "harness"'),
    (re.compile(r"\bfleet\b", re.I), 'infrastructure name "fleet"'),
    (re.compile(r"\bcontrol[ -]plane\b", re.I), 'infrastructure name "control plane"'),
    (re.compile(r"\bobserver\b", re.I), 'infrastructure name "observer"'),
    (re.compile(r"\bvantage\b", re.I), 'infrastructure name "vantage"'),
    (re.compile(r"\bnodes?\b(?!\.js|:[a-z])", re.I), 'infrastructure name "node"'),
    (re.compile(r"\bMacs?\b"), 'infrastructure name "Mac"'),
    (re.compile(r"\b8443\b"), "an internal port number"),
    (re.compile(r"\b[VW]-?\d{2,5}\b"), "an internal ticket id"),
    (re.compile(r"\b(?:sub-)?slice \d", re.I), "an internal work item"),
    (re.compile(r"\bArc \d"), "an internal work item"),
    (re.compile(r"\bWave \d"), "an internal work item"),
    (re.compile(r"\bLK\.\d"), "an internal work item"),
    (re.compile(r"\bv2-#\d"), "an internal work item"),
    (re.compile(r"\bQ\.\d"), "an internal work item"),
    (re.compile(r"\b[PT]-\d+\b"), "an internal work item"),
    (re.compile(r"\bdoc-\d+"), "an internal planning document"),
    (re.compile(r"\bplanning \d+", re.I), "an internal planning document"),
    (re.compile(r"\bTier-3\b"), "an internal decision label"),
    (re.compile(r"\bA[1-3]\b"), "an agent name"),
    (re.compile(r"\bfounder\b", re.I), "a personal role"),
]

AI_ERROR_CLASSES = {
    "ForbiddenError",
    "ConflictError",
    "BundledLlmBudgetExhaustedError",
    "BundledLlmConsentRequiredError",
    "ByokAnthropicRequiredError",
}


def findings(label: str, text: str) -> list[str]:
    out = []
    for pattern, why in INTERNAL:
        match = pattern.search(text)
        if match is not None:
            out.append(f'{label}: {why} — "{match.group(0)}"')
    return out


def strings_and_comments(path: Path) -> list[tuple[int, str]]:
    """Every string literal (docstrings included) and every comment, with lines."""
    source = path.read_text(encoding="utf-8")
    out: list[tuple[int, str]] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            out.append((node.lineno, node.value))
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT:
            out.append((token.start[0], token.string))
    return out


def class_docs(path: Path, names: set[str]) -> dict[str, str]:
    """Docstrings of the named classes and of everything defined inside them."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docs: dict[str, str] = {}
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name in names:
            parts = [ast.get_docstring(node) or ""]
            for child in node.body:
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    parts.append(ast.get_docstring(child) or "")
            docs[node.name] = "\n".join(parts)
    return docs


def test_control_the_matcher_flags_each_kind_of_internal_reference_and_passes_product_copy() -> (
    None
):
    assert len(findings("planted", "the harness on node W1234 (Slice 3)")) == 4
    assert len(findings("planted", "see LK.3 and doc-132, agreed with A3")) == 3
    assert (
        findings(
            "plain",
            "Stop the running task. Python 3.10 or later. The browser runs your session.",
        )
        == []
    )


def test_the_collectors_read_real_text_so_an_empty_scan_cannot_pass_for_a_clean_one() -> None:
    texts = strings_and_comments(RESOURCE)
    assert len(texts) > 60
    assert any("Stop the session's running turn" in t for _, t in texts)
    docs = class_docs(ERRORS, AI_ERROR_CLASSES)
    assert set(docs) == AI_ERROR_CLASSES
    assert all(len(d) > 40 for d in docs.values())


def test_every_docstring_string_and_comment_in_the_resource_is_free_of_internal_references() -> (
    None
):
    hits = [
        hit
        for line, text in strings_and_comments(RESOURCE)
        for hit in findings(f"agent_sessions.py:{line}", text)
    ]
    assert hits == []


def test_the_ai_error_classes_document_themselves_without_internal_references() -> None:
    hits = [
        hit
        for name, doc in class_docs(ERRORS, AI_ERROR_CLASSES).items()
        for hit in findings(f"errors.py {name}", doc)
    ]
    assert hits == []


def test_the_ai_example_is_free_of_internal_references() -> None:
    lines = EXAMPLE.read_text(encoding="utf-8").splitlines()
    hits = [hit for i, line in enumerate(lines, 1) for hit in findings(f"agent_chat.py:{i}", line)]
    assert hits == []


# ── The whole shipped package, not only the AI surface ──────────────────────
#
# 2026-09-20. The three arms above read the agent-sessions resource, five error
# classes and the AI example, because that was the surface under review. Every
# module in `src/driftstack` ships: the wheel carries the compiled package and
# the sdist carries this source verbatim, and `help()` shows these docstrings to
# a customer for any resource they touch, not just the AI one. So the same
# question is asked of all of them.

SHIPPED_MODULES = sorted((PKG / "src" / "driftstack").rglob("*.py"))

# The ONE exemption, with its reason. The proxy-test route answers with
# ``measured_from: "fleet"`` or ``"control_plane"`` and takes ``?vantage=fleet``
# on the way in. Those are WIRE VALUES — the server sends them, a customer types
# them, and the API's own OpenAPI description publishes both — so the generated
# models have to be able to spell them. Renaming one is a breaking change to the
# API, not an edit to a comment, and belongs to whoever owns that contract.
#
# The exemption is a WHOLE-LITERAL match, not a word match: a string whose
# entire value IS one of the enum members is the wire value. A docstring that
# happens to contain the word is prose and is still reported — the difference
# between an exemption and an off switch. The control below asserts both halves.
MEASURED_FROM_ENUM = frozenset({"fleet", "control_plane"})


def is_wire_value(text: str) -> bool:
    """True when the whole literal IS a published `measured_from` enum member."""
    return text in MEASURED_FROM_ENUM


def test_the_shipped_walk_really_read_the_package_so_an_empty_scan_cannot_pass() -> None:
    names = {p.relative_to(PKG / "src" / "driftstack").as_posix() for p in SHIPPED_MODULES}
    assert len(SHIPPED_MODULES) >= 25
    assert {"client.py", "errors.py", "http.py", "resources/account.py"} <= names
    texts = [t for p in SHIPPED_MODULES for _, t in strings_and_comments(p)]
    assert len(texts) > 500
    assert any("Rotate an API key with a 24h grace period" in t for t in texts)


def test_every_shipped_module_documents_itself_without_internal_references() -> None:
    hits = [
        hit
        for path in SHIPPED_MODULES
        for line, text in strings_and_comments(path)
        if not is_wire_value(text)
        for hit in findings(f"{path.relative_to(PKG).as_posix()}:{line}", text)
    ]
    assert hits == []


def test_control_the_wire_value_exemption_excuses_the_value_and_nothing_else() -> None:
    assert is_wire_value("fleet")
    assert is_wire_value("control_plane")
    assert findings("value", "fleet") != []

    prose = "routes the session to the device fleet"
    assert not is_wire_value(prose)
    assert findings("prose", prose) != []
