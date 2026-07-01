
## Per-tenant white-label branding

`tenantThemeVars(override)` / `tenantThemeCss(override)` resolve a tenant's brand (accent + on-accent,
heading/body fonts, corner radii) into only the **changed** `--gw-*` variables, for light **and** dark,
so a workspace can be re-branded at runtime (client applies them via `documentElement.style.setProperty`,
CSP-safe). Accessibility is enforced **per theme** via `applyTenantTheme` + `auditThemeContrast`: a brand
colour that fails WCAG-AA on a given theme's background is dropped and that theme keeps the accessible
default (`degraded: true`) — a tenant can never ship an unreadable re-brand. The AI-agency colours
(mint/emerald) are never re-branded.
