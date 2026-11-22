---
'@weaveintel/extraction': patch
'@weaveintel/guardrails': patch
---

Remove regular expressions that could run in quadratic time on hostile files, and make two sanitisers complete.

- **extraction.** The PDF, HTML, number-mapping, JSON-answer and base-URL code now scans in linear time.
  `htmlToText` removes comments and script/style blocks until none is left, and an unclosed comment or
  script runs to the end of the input, as in a browser. Google Drive folder queries escape backslashes as well as quotes.
- **guardrails.** `fileSpotlight().wrap` strips forged fence markers until none is left, so cutting one cannot
  join its neighbours into another.
