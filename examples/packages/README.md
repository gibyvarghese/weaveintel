# Package examples

One file per `@weaveintel/*` package. Each example:

- Runs fully in-memory — no external services, no API keys
- Uses `assert` to verify each step rather than just printing output
- Has thorough inline comments explaining what each API call does and why
- Flags every local helper that is NOT from a package so adopters know the boundary

Run any file:

```bash
npx tsx examples/packages/resilience.ts
npx tsx examples/packages/encryption.ts
# etc.
```
