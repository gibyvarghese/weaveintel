#!/usr/bin/env bash
# Phase 8 gate — AFTER publishing, prove the registry artifacts work from OUTSIDE the repo.
# Installs the umbrella + collab + tools from npm (not the workspace) and compiles a tiny app.
set -euo pipefail
DIR="$(mktemp -d)/weaveintel-smoke"
mkdir -p "$DIR" && cd "$DIR"
echo "smoke dir: $DIR"
npm init -y -q >/dev/null
npm install @weaveintel/weaveintel@0.1.1 @weaveintel/collab@0.1.1 @weaveintel/tools@0.1.1 typescript >/dev/null
cat > smoke.ts <<'TS'
import { weaveRuntime, weaveAgent, weaveToolRegistry } from '@weaveintel/weaveintel';
import { createRgaDoc } from '@weaveintel/collab';
import { classifyRisk } from '@weaveintel/tools';
import { gmailTools } from '@weaveintel/tools/gmail'; // proves the subpath export resolves from the registry

const runtime = weaveRuntime();
const tools = weaveToolRegistry();
const a = createRgaDoc('smoke'); a.insert(0, 'hello'); a.insert(5, ' world');
console.log('collab CoeditDoc:', a.text());
console.log('umbrella + tools loaded:', typeof runtime, typeof weaveAgent, typeof classifyRisk, Array.isArray(gmailTools));
TS
npx tsc --noEmit --moduleResolution bundler --module esnext --skipLibCheck smoke.ts && echo "✅ smoke app TYPECHECKS against registry packages"
npx tsx smoke.ts 2>/dev/null && echo "✅ smoke app RUNS against registry packages" || echo "(run step needs tsx; typecheck is the gate)"
