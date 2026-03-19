---
paths:
  - ".github/label-definitions.yaml"
---

# Label Management

When a label is added or modified in `.github/label-definitions.yaml`:

1. Update `.github/release.yml` — add a corresponding category entry so the label appears in release notes (all `kind/*` labels should have their own category)
2. Check `.tagpr` — update `majorLabels` or `minorLabels` if the new label should affect version bumping (labels not listed default to patch)
