package main

import rego.v1

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

h(depth, text) := {"type": "heading", "depth": depth, "children": [{"type": "text", "value": text}]}

guide_doc(filename, children) := {"type": "root", "children": children, "metadata": {"filename": filename}}

# ---------------------------------------------------------------------------
# Rule 1: Guide filename kebab-case with gerund
# ---------------------------------------------------------------------------

test_guide_filename_valid if {
	count(deny) == 0 with input as guide_doc("creating-themes.md", [h(1, "Creating Themes")])
}

test_guide_filename_valid_multi_segment if {
	count(deny) == 0 with input as guide_doc("deploying-to-fly-io.md", [h(1, "Deploying to Fly.io")])
}

test_guide_filename_no_gerund if {
	"Guide filename must be kebab-case starting with a gerund (e.g., creating-themes.md), got: 'setup-guide.md'" in deny with input as guide_doc("setup-guide.md", [h(1, "Setup Guide")])
}

test_guide_filename_snake_case_rejected if {
	"Guide filename must be kebab-case starting with a gerund (e.g., creating-themes.md), got: 'creating_themes.md'" in deny with input as guide_doc("creating_themes.md", [h(1, "Creating Themes")])
}

test_guide_filename_uppercase_rejected if {
	"Guide filename must be kebab-case starting with a gerund (e.g., creating-themes.md), got: 'Creating-Themes.md'" in deny with input as guide_doc("Creating-Themes.md", [h(1, "Creating Themes")])
}

# ---------------------------------------------------------------------------
# Rule 2: Guide H1 first word matches filename first segment
# ---------------------------------------------------------------------------

test_guide_h1_matches_filename if {
	count(deny) == 0 with input as guide_doc("creating-themes.md", [h(1, "Creating Themes")])
}

test_guide_h1_mismatch if {
	"Guide H1 first word 'configuring' must match filename first segment 'creating'" in deny with input as guide_doc("creating-themes.md", [h(1, "Configuring Themes")])
}
