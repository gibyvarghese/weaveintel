---
"@weaveintel/collab": minor
---

Add a scoped collaboration receiving boundary and opt-in full-history journals
for gap-safe RGA and block-document replay. Authentication, durable storage and
transport remain host responsibilities.
Allow plain-text local inserts of supplementary Unicode code points and preserve them and their
mark ranges through block diffs, ProseMirror, Markdown and HTML conversion.
Reject client operations with fractional or unsafe counters and empty site namespaces.
Fail local edits before counter overflow rather than generating duplicate or imprecise operation IDs.
Make out-of-range deletes no-ops instead of deleting the last character or a block marker.
