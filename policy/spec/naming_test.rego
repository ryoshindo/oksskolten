package main

import rego.v1

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

h(depth, text) := {"type": "heading", "depth": depth, "children": [{"type": "text", "value": text}]}

bto := {"type": "blockquote", "children": [{"type": "paragraph", "children": [{"type": "link", "url": "./01_overview.md", "children": [{"type": "text", "value": "Back to Overview"}]}]}]}

named_doc(filename, children) := {"type": "root", "children": _inject_bto(filename, children), "metadata": {"filename": filename}}

# Inject back-to-overview blockquote after H1 for non-overview files
_inject_bto(filename, children) := result if {
	filename == "01_overview.md"
	result := children
}

_inject_bto(filename, children) := result if {
	filename != "01_overview.md"
	count(children) > 0
	result := array.concat([children[0], bto], array.slice(children, 1, count(children)))
}

# ---------------------------------------------------------------------------
# Rule 9: Filename format
# ---------------------------------------------------------------------------

test_filename_valid_en if {
	count(deny) == 0 with input as named_doc("80_feature_clip.md", [h(1, "Oksskolten Spec — Clip")])
}

test_filename_valid_core if {
	count(deny) == 0 with input as named_doc("10_schema.md", [h(1, "Oksskolten Spec — Schema")])
}

test_filename_invalid_no_prefix if {
	"Filename must match {NN}_{snake_case}.md, got: 'overview.md'" in deny with input as named_doc("overview.md", [h(1, "Oksskolten Spec — Overview")])
}

test_filename_invalid_uppercase if {
	"Filename must match {NN}_{snake_case}.md, got: '80_Feature_Clip.md'" in deny with input as named_doc("80_Feature_Clip.md", [h(1, "Oksskolten Spec — Clip")])
}

test_filename_invalid_hyphen if {
	"Filename must match {NN}_{snake_case}.md, got: '80_feature-clip.md'" in deny with input as named_doc("80_feature-clip.md", [h(1, "Oksskolten Spec — Clip")])
}

test_filename_ja_rejected if {
	"Filename must match {NN}_{snake_case}.md, got: '80_feature_clip.ja.md'" in deny with input as named_doc("80_feature_clip.ja.md", [h(1, "Oksskolten Spec — Clip")])
}

# ---------------------------------------------------------------------------
# Rule 10: Number prefix category
# ---------------------------------------------------------------------------

test_8x_feature_valid if {
	count(deny) == 0 with input as named_doc("81_feature_images.md", [h(1, "Oksskolten Spec — Images")])
}

test_9x_perf_valid if {
	count(deny) == 0 with input as named_doc("90_perf_retry_backoff.md", [h(1, "Oksskolten Spec — Retry Backoff")])
}

test_8x_without_feature_infix if {
	"Filename with 8x prefix must contain '_feature_', got: '80_clip.md'" in deny with input as named_doc("80_clip.md", [h(1, "Oksskolten Spec — Clip")])
}

test_9x_without_perf_infix if {
	"Filename with 9x prefix must contain '_perf_', got: '90_retry_backoff.md'" in deny with input as named_doc("90_retry_backoff.md", [h(1, "Oksskolten Spec — Retry Backoff")])
}

test_feature_infix_wrong_prefix if {
	"Feature spec must use 8x prefix, got: '50_feature_something.md'" in deny with input as named_doc("50_feature_something.md", [h(1, "Oksskolten Spec — Something")])
}

test_perf_infix_wrong_prefix if {
	"Perf spec must use 9x prefix, got: '50_perf_something.md'" in deny with input as named_doc("50_perf_something.md", [h(1, "Oksskolten Spec — Something")])
}

test_core_spec_no_category_constraint if {
	count(deny) == 0 with input as named_doc("20_api.md", [h(1, "Oksskolten Spec — API")])
}
