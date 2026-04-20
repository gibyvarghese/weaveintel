/**
 * geneWeave HTML Generation (Server-side only)
 * 
 * This module generates the initial HTML page that loads the client-side UI module.
 * It's separate from ui-client.ts to avoid bundling server-side dependencies
 * (like @weaveintel/core) into the browser module.
 */

import { ADMIN_TAB_GROUPS, ADMIN_TABS } from './admin-schema.js';
import { STYLES } from './ui/styles.js';

export function getHTML(): string {
  // Embed admin schema and styles as inline content
  const adminGroupsJson = JSON.stringify(ADMIN_TAB_GROUPS);
  const adminSchemaJson = JSON.stringify(ADMIN_TABS);
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>geneWeave</title>
  <style>${STYLES}</style>
  <script src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"></script>
</head>
<body>
<div id="root"></div>
<script>
// Embed admin schema as global variables so client code can access them
window.ADMIN_GROUPS = ${adminGroupsJson};
window.ADMIN_SCHEMA = ${adminSchemaJson};
</script>
<script type="module">
  import { initialize } from '/ui.js';
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
</script>
</body>
</html>`;
}
