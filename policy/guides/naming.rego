package main

import rego.v1

# Helper: extract text from heading node children
_guide_heading_text(h) := concat("", [c.value | some c in h.children; c.type == "text"])

_guide_filename := object.get(input, ["metadata", "filename"], "")

# Rule 1: Guide filename must be kebab-case and start with a gerund (verbing-object)
deny contains msg if {
	_guide_filename != ""
	not regex.match(`^[a-z]+ing-[a-z0-9][a-z0-9-]*\.md$`, _guide_filename)
	msg := sprintf("Guide filename must be kebab-case starting with a gerund (e.g., creating-themes.md), got: '%s'", [_guide_filename])
}

# Rule 2: Guide H1 first word must match filename first segment
deny contains msg if {
	_guide_filename != ""
	some h in input.children
	h.type == "heading"
	h.depth == 1
	h1_text := _guide_heading_text(h)
	h1_first_word := lower(split(h1_text, " ")[0])
	filename_first_segment := split(trim_suffix(_guide_filename, ".md"), "-")[0]
	h1_first_word != filename_first_segment
	msg := sprintf("Guide H1 first word '%s' must match filename first segment '%s'", [h1_first_word, filename_first_segment])
}
