# @weaveintel/tools-enterprise

**A ready-made toolbelt of enterprise connectors — Jira, Confluence, Salesforce, Notion, ServiceNow, Canva — for your agent.**

## Why it exists

A company doesn't keep its work in one place: tickets live in Jira, docs in Confluence, customers in Salesforce, records in ServiceNow. Wiring an agent to each one means learning six different APIs and six different login schemes. This package is the pre-cut set of house keys: each connector already knows how to query, read, and create records in its system, and a shared auth manager handles the various locks (OAuth 2.0, OIDC, basic, API key, client credentials) so you don't hand-roll each one. It sits on top of `@weaveintel/tools`, adding a business-systems toolbelt to the standard one.

It's a **separate package for a separate audience**: teams that don't touch these enterprise systems shouldn't carry their connectors, and the folks who do get one focused, well-scoped dependency.

## When to reach for it

Reach for it when your agent must read or write in real enterprise systems like Jira or ServiceNow. If you only need general-purpose tools (files, math, web), stay with `@weaveintel/tools`. For arbitrary browser automation instead of a first-class API, see `@weaveintel/tools-browser`.

## How to use it

```ts
import { createEnterpriseTools } from '@weaveintel/tools-enterprise';

const tools = createEnterpriseTools([
  {
    name: 'acme-jira',
    type: 'jira',
    enabled: true,
    baseUrl: 'https://acme.atlassian.net',
    // ...auth credentials for this connector
  },
]);
// `tools` is a Tool[] ready to register with your agent
```

## What's in the box

| Export | What it does |
| --- | --- |
| `createEnterpriseTools(configs, extra?, opts?)` | Build a `Tool[]` from your connector configs |
| `createEnterpriseToolGroups(...)` | Same, grouped by provider |
| `JiraFullProvider`, `ServiceNowProvider`, `CanvaProvider` | Full-coverage connectors |
| `JiraProvider`, `ConfluenceProvider`, `SalesforceProvider`, `NotionProvider` | Core connectors |
| `AuthManager` + `jiraOAuth2`, `serviceNowClientCredentials`, `canvaOAuth2`, … | Shared auth across OAuth/OIDC/basic/API-key/client-credentials |
| `BaseEnterpriseProvider`, `EnterpriseProvider` | Extend with your own connector |

## License

MIT.
