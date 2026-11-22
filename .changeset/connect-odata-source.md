---
'@weaveintel/connect': minor
---

New subpath `@weaveintel/connect/sources`: an OData (v4) source on the generic operation runner. `odataOperation(source)`
turns an entity set, selected fields, typed filters, a limit and a page size into the runner's operation and mapping
rows (`$select`, `$filter`, `$top`, `Prefer: odata.maxpagesize`, paging by `@odata.nextLink` on the source's own host);
`odataFilter` writes each filter value as an OData literal of its declared type, so no tool input can add a clause.
Runner paths may now quote a key that has dots in it: `["@odata.nextLink"]`.
