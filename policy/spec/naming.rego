package main

import rego.v1

filename := object.get(input, ["metadata", "filename"], "")

# Rule 9: Filename must match {NN}_{snake_case}.md
deny contains msg if {
	filename != ""
	not regex.match(`^\d{2}_[a-z][a-z0-9_]*\.md$`, filename)
	msg := sprintf("Filename must match {NN}_{snake_case}.md, got: '%s'", [filename])
}

# Rule 10: Number prefix category must match content type
# 0x = overview/architecture, 1x-5x = core specs, 8x = feature, 9x = perf
valid_prefix_categories := {
	"8": "_feature_",
	"9": "_perf_",
}

deny contains msg if {
	filename != ""
	prefix_digit := substring(filename, 0, 1)
	expected_infix := valid_prefix_categories[prefix_digit]
	not contains(filename, expected_infix)
	msg := sprintf("Filename with %sx prefix must contain '%s', got: '%s'", [prefix_digit, expected_infix, filename])
}

deny contains msg if {
	filename != ""
	contains(filename, "_feature_")
	not startswith(filename, "8")
	msg := sprintf("Feature spec must use 8x prefix, got: '%s'", [filename])
}

deny contains msg if {
	filename != ""
	contains(filename, "_perf_")
	not startswith(filename, "9")
	msg := sprintf("Perf spec must use 9x prefix, got: '%s'", [filename])
}
