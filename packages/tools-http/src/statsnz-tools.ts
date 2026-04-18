/**
 * Stats NZ — Aotearoa Data Explorer (ADE) API tools
 *
 * Provides tools to query the Stats NZ ADE REST API (SDMX 2.1 compliant).
 * Base URL: https://api.data.stats.govt.nz/rest/
 * Auth: Ocp-Apim-Subscription-Key header (set STATSNZ_API_KEY env var)
 */
/**
 * Stats NZ — Aotearoa Data Explorer (ADE) API tools
 *
 * Provides tools to query the Stats NZ ADE REST API (SDMX 2.1 compliant).
 * Base URL: https://api.data.stats.govt.nz/rest/
 * Auth: Ocp-Apim-Subscription-Key header — set STATSNZ_API_KEY env var.
 *
 * ─── SDMX 2.1 CONCEPTS ────────────────────────────────────────────────────────
 *
 * Dataflow       A named, versioned dataset published by Stats NZ (e.g. AGR_AGR_001
 *                "Agricultural land use"). Each dataflow is backed by a Data Structure
 *                Definition (DSD) that lists its dimensions.
 *
 * DSD            Data Structure Definition. Describes the dimensions (axes) of a
 *                dataflow and links each dimension to a codelist.
 *
 * Codelist       An enumeration of valid codes for one dimension. For example the
 *                AREA dimension might have codes "1" (Auckland), "10" (Wellington) etc.
 *
 * Key            A dot-separated filter string with one slot per dimension in DSD order:
 *                  "all"           → all data, no filter
 *                  "6050.1.2018"   → dimension-1 = code 6050, dim-2 = 1, dim-3 = 2018
 *                  "6050+7010.1."  → OR within a dimension (6050 OR 7010), empty slot = all
 *
 * ActualConstraint  A pre-computed manifest of which dimension-value combinations
 *                   currently have observations.  Stats NZ names these CR_A_{dataflow_id}
 *                   (e.g. CR_A_AGR_AGR_001).
 *
 * SDMX JSON v2   Stats NZ returns application/vnd.sdmx.data+json;version=2 for
 *                format=jsondata.  With dimensionAtObservation=AllDimensions the
 *                response has a flat observations map keyed "d0:d1:d2" (dimension
 *                position indices) — there are no nested series objects.
 *
 * ─── KNOWN API QUIRKS ─────────────────────────────────────────────────────────
 *
 * • dimensionAtObservation MUST be "AllDimensions" — omitting it causes HTTP 500
 *   "languageTag1" from the Stats NZ backend.
 * • Data endpoint calls can also return HTTP 500 "languageTag1" unless
 *   `Accept-Language: en` is sent. We set this header by default.
 * • The /structure endpoint returns HTTP 501 "Not Implemented"; use /dataflow with
 *   references=all instead (equivalent result).
 * • ActualConstraint IDs follow the pattern CR_A_{dataflow_id}, not the bare ID.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { weaveTool } from '@weaveintel/core';
import type { Tool } from '@weaveintel/core';

const ADE_BASE = 'https://api.data.stats.govt.nz/rest';
const AGENCY = 'STATSNZ';

function getApiKey(): string | undefined {
  return process.env['STATSNZ_API_KEY'];
}

function buildHeaders(): Record<string, string> {
  const apiKey = getApiKey();
  const headers: Record<string, string> = {
    'user-agent': '@weaveintel/tools-http statsnz/1.0',
    'accept-encoding': 'gzip',
    // Required by ADE data endpoint to avoid intermittent 500 "languageTag1" responses.
    'accept-language': 'en',
  };
  if (apiKey) {
    headers['Ocp-Apim-Subscription-Key'] = apiKey;
  }
  return headers;
}

async function adeGet(path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`${ADE_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: buildHeaders(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Stats NZ ADE API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    return response.json();
  }
  return response.text();
}

interface SdmxDataflow {
  id: string;
  agencyID: string;
  version: string;
  name?: string;
  description?: string;
}

interface ParsedDimension {
  id: string;
  position: number;
  name: string;
  codelistID: string | null;
}

interface ParsedCodelist {
  id: string;
  name: string;
  codeCount: number;
  codes?: Array<{ code: string; label: string }>;
}

interface ParsedConstraintSummary {
  cubeRegionCount: number;
  keyValueCount: number;
}

interface SdmxJsonResponse {
  data?: {
    dataflows?: Array<{
      id: string;
      agencyID: string;
      version: string;
      names?: Record<string, string>;
      descriptions?: Record<string, string>;
    }>;
    dataStructures?: Array<{
      id: string;
      agencyID: string;
      version: string;
      names?: Record<string, string>;
      dataStructureComponents?: {
        dimensionList?: {
          dimensions?: Array<{
            id: string;
            position: number;
            names?: Record<string, string>;
            localRepresentation?: {
              enumeration?: { id: string; agencyID: string; version: string };
            };
          }>;
        };
      };
    }>;
    codelists?: Array<{
      id: string;
      agencyID: string;
      version: string;
      names?: Record<string, string>;
      codes?: Array<{ id: string; names?: Record<string, string> }>;
    }>;
  };
}

function parseName(names?: Record<string, string>): string {
  if (!names) return '';
  return names['en'] ?? Object.values(names)[0] ?? '';
}

function decodeXmlEntities(input: string): string {
  return input
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

function getAttr(xmlFragment: string, attr: string): string | null {
  const escaped = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xmlFragment.match(new RegExp(`${escaped}="([^"]+)"`));
  return match?.[1] ?? null;
}

function stripXmlTags(input: string): string {
  return decodeXmlEntities(input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function parseDataflowsFromXml(xml: string): SdmxDataflow[] {
  const flows: SdmxDataflow[] = [];
  const dataflowBlocks = xml.match(/<structure:Dataflow\b[\s\S]*?<\/structure:Dataflow>/g) ?? [];
  for (const block of dataflowBlocks) {
    const openTag = block.match(/<structure:Dataflow\b[^>]*>/)?.[0] ?? '';
    const id = getAttr(openTag, 'id') ?? '';
    if (!id) continue;
    const agencyID = getAttr(openTag, 'agencyID') ?? AGENCY;
    const version = getAttr(openTag, 'version') ?? 'latest';
    const nameMatch = block.match(/<common:Name\b[^>]*>([\s\S]*?)<\/common:Name>/);
    const descriptionMatch = block.match(/<common:Description\b[^>]*>([\s\S]*?)<\/common:Description>/);
    flows.push({
      id,
      agencyID,
      version,
      name: nameMatch ? stripXmlTags(nameMatch[1] ?? '') : '',
      description: descriptionMatch ? stripXmlTags(descriptionMatch[1] ?? '') : '',
    });
  }
  return flows;
}

function parseDataflowInfoFromXml(xml: string): {
  name: string;
  description: string;
  dimensions: ParsedDimension[];
  codelists: ParsedCodelist[];
} {
  const flowName = stripXmlTags(xml.match(/<common:Name\b[^>]*>([\s\S]*?)<\/common:Name>/)?.[1] ?? '');
  const flowDescription = stripXmlTags(
    xml.match(/<common:Description\b[^>]*>([\s\S]*?)<\/common:Description>/)?.[1] ?? '',
  );

  const dimensions: ParsedDimension[] = [];
  const dimBlocks = xml.match(/<structure:Dimension\b[\s\S]*?<\/structure:Dimension>/g) ?? [];
  for (const block of dimBlocks) {
    const openTag = block.match(/<structure:Dimension\b[^>]*>/)?.[0] ?? '';
    const id = getAttr(openTag, 'id') ?? '';
    if (!id) continue;
    const position = Number(getAttr(openTag, 'position') ?? `${dimensions.length + 1}`);
    const name = stripXmlTags(block.match(/<common:Name\b[^>]*>([\s\S]*?)<\/common:Name>/)?.[1] ?? id);
    const enumTag = block.match(/<Ref\b[^>]*class="Codelist"[^>]*>/)?.[0] ?? '';
    const codelistID = getAttr(enumTag, 'id');
    dimensions.push({ id, position, name, codelistID });
  }

  const codelists: ParsedCodelist[] = [];
  const codelistBlocks = xml.match(/<structure:Codelist\b[\s\S]*?<\/structure:Codelist>/g) ?? [];
  for (const block of codelistBlocks) {
    const openTag = block.match(/<structure:Codelist\b[^>]*>/)?.[0] ?? '';
    const id = getAttr(openTag, 'id') ?? '';
    if (!id) continue;
    const name = stripXmlTags(block.match(/<common:Name\b[^>]*>([\s\S]*?)<\/common:Name>/)?.[1] ?? id);
    const codeCount = (block.match(/<structure:Code\b/g) ?? []).length;
    codelists.push({ id, name, codeCount });
  }

  dimensions.sort((a, b) => a.position - b.position);
  return {
    name: flowName,
    description: flowDescription,
    dimensions,
    codelists,
  };
}

function parseCodelistFromXml(xml: string): ParsedCodelist | null {
  const block = xml.match(/<structure:Codelist\b[\s\S]*?<\/structure:Codelist>/)?.[0];
  if (!block) return null;
  const openTag = block.match(/<structure:Codelist\b[^>]*>/)?.[0] ?? '';
  const id = getAttr(openTag, 'id') ?? '';
  if (!id) return null;
  const name = stripXmlTags(block.match(/<common:Name\b[^>]*>([\s\S]*?)<\/common:Name>/)?.[1] ?? id);

  const codes: Array<{ code: string; label: string }> = [];
  const codeBlocks = block.match(/<structure:Code\b[\s\S]*?<\/structure:Code>/g) ?? [];
  for (const codeBlock of codeBlocks) {
    const codeOpen = codeBlock.match(/<structure:Code\b[^>]*>/)?.[0] ?? '';
    const code = getAttr(codeOpen, 'id') ?? '';
    if (!code) continue;
    const label = stripXmlTags(codeBlock.match(/<common:Name\b[^>]*>([\s\S]*?)<\/common:Name>/)?.[1] ?? code);
    codes.push({ code, label });
  }

  return {
    id,
    name,
    codeCount: codes.length,
    codes,
  };
}

function parseConstraintSummaryFromXml(xml: string): ParsedConstraintSummary {
  const cubeRegionCount = (xml.match(/<[^>]*:?CubeRegion\b/g) ?? []).length;
  const keyValueCount = (xml.match(/<[^>]*:?KeyValue\b/g) ?? []).length;
  return { cubeRegionCount, keyValueCount };
}

function parseDataflows(raw: unknown): SdmxDataflow[] {
  if (typeof raw === 'string') {
    return parseDataflowsFromXml(raw);
  }
  const sdmx = raw as SdmxJsonResponse;
  const flows = sdmx?.data?.dataflows ?? [];
  return flows.map((df) => ({
    id: df.id,
    agencyID: df.agencyID,
    version: df.version,
    name: parseName(df.names),
    description: parseName(df.descriptions),
  }));
}

const listDataflowsTool = weaveTool({
  name: 'statsnz_list_dataflows',
  description:
    'List all available Stats NZ datasets (dataflows) from the Aotearoa Data Explorer. ' +
    'Returns a catalogue of tables with their IDs, names, and versions. ' +
    'Use the dataflow ID in other statsnz_* tools to query specific tables.',
  parameters: {
    type: 'object',
    properties: {
      detail: {
        type: 'string',
        enum: ['allstubs', 'full'],
        description:
          '"allstubs" returns a lightweight catalogue (faster). ' +
          '"full" includes dimension details (slower). Default: allstubs.',
      },
    },
    required: [],
  },
  execute: async (args: {
    // 'allstubs' — only IDs and names; 'full' — includes all structural details
    detail?: 'allstubs' | 'full';
  }) => {
    const detail = args.detail ?? 'allstubs';
    // references=none: do not expand linked objects (codelists, DSD) — just the flow list
    const raw = await adeGet(`/dataflow/${AGENCY}/all/latest`, { detail, references: 'none' });
    const flows = parseDataflows(raw);
    if (flows.length === 0) {
      return JSON.stringify({ count: 0, dataflows: [], note: 'No dataflows returned. Check your API key (STATSNZ_API_KEY).' });
    }
    return JSON.stringify({ count: flows.length, dataflows: flows }, null, 2);
  },
  tags: ['stats-nz', 'data', 'new-zealand'],
});

const searchDataflowsTool = weaveTool({
  name: 'statsnz_search_dataflows',
  description:
    'Search Stats NZ datasets by keyword. Filters the full catalogue of Aotearoa Data Explorer tables by name or description. ' +
    'Returns matching dataflows with their IDs to use in statsnz_get_data.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keyword or phrase to search for in dataset names and descriptions (case-insensitive).',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return. Default: 20.',
      },
    },
    required: ['query'],
  },
  execute: async (args: { query: string; limit?: number }) => {
    const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20)));
    const raw = await adeGet(`/dataflow/${AGENCY}/all/latest`, { detail: 'allstubs', references: 'none' });
    const flows = parseDataflows(raw);
    const q = args.query.toLowerCase();
    const matches = flows.filter(
      (f) =>
        f.id.toLowerCase().includes(q) ||
        (f.name ?? '').toLowerCase().includes(q) ||
        (f.description ?? '').toLowerCase().includes(q),
    );
    return JSON.stringify({
      query: args.query,
      count: matches.length,
      showing: Math.min(matches.length, limit),
      dataflows: matches.slice(0, limit),
    }, null, 2);
  },
  tags: ['stats-nz', 'data', 'search', 'new-zealand'],
});

const getDataflowInfoTool = weaveTool({
  name: 'statsnz_get_dataflow_info',
  description:
    'Get structural metadata for a specific Stats NZ dataset, including dimensions and codelist IDs. ' +
    'Use this before statsnz_get_data to understand what dimension codes are available for filtering.',
  parameters: {
    type: 'object',
    properties: {
      dataflow_id: {
        type: 'string',
        description: 'The dataflow ID of the table, e.g. "AGR_AGR_001".',
      },
      version: {
        type: 'string',
        description: 'Version of the dataflow. Default: "1.0". Use "latest" when needed.',
      },
    },
    required: ['dataflow_id'],
  },
  execute: async (args: { dataflow_id: string; version?: string }) => {
    const version = args.version ?? '1.0';
    const raw = await adeGet(
      `/dataflow/${AGENCY}/${encodeURIComponent(args.dataflow_id)}/${version}`,
      { references: 'all', detail: 'referencepartial' },
    );

    let dsName = args.dataflow_id;
    let dsDesc = '';
    let dimensions: Array<{ id: string; name: string; position: number; codelistID: string | null }> = [];
    let codelists: Array<{ id: string; name: string; codeCount: number }> = [];

    if (typeof raw === 'string') {
      const parsed = parseDataflowInfoFromXml(raw);
      dsName = parsed.name || dsName;
      dsDesc = parsed.description;
      dimensions = parsed.dimensions;
      codelists = parsed.codelists;
    } else {
      const json = raw as SdmxJsonResponse;
      const df = json?.data?.dataflows?.[0];
      dsName = df ? parseName(df.names) : dsName;
      dsDesc = df ? parseName(df.descriptions) : '';
      const ds = json?.data?.dataStructures?.[0];
      const dims = ds?.dataStructureComponents?.dimensionList?.dimensions ?? [];
      dimensions = dims
        .sort((a, b) => a.position - b.position)
        .map((d) => ({
          id: d.id,
          name: parseName(d.names),
          position: d.position,
          codelistID: d.localRepresentation?.enumeration?.id ?? null,
        }));
      codelists = (json?.data?.codelists ?? []).map((cl) => ({
        id: cl.id,
        name: parseName(cl.names),
        codeCount: (cl.codes ?? []).length,
      }));
    }

    return JSON.stringify({
      dataflow_id: args.dataflow_id,
      version,
      name: dsName,
      description: dsDesc,
      dimensions,
      codelists,
    }, null, 2);
  },
  tags: ['stats-nz', 'metadata', 'new-zealand'],
});


const getDatastructureTool = weaveTool({
  name: 'statsnz_get_datastructure',
  description:
    'Get the Stats NZ Data Structure Definition (DSD) for a dataflow, including ordered dimensions and related codelists. ' +
    'Use this to construct valid SDMX keys for statsnz_get_data.',
  parameters: {
    type: 'object',
    properties: {
      dataflow_id: {
        type: 'string',
        description:
          'The DSD ID — same as the dataflow ID (e.g. "AGR_AGR_001"). Stats NZ uses the ' +
          'same identifier for both the dataflow and its underlying data structure.',
      },
      version: {
        type: 'string',
        description: 'Version string. Default: "1.0". Use "latest" for the most recent version.',
      },
      detail: {
        type: 'string',
        enum: ['allstubs', 'referencestubs', 'referencepartial', 'full'],
        description:
          'Controls how much structural metadata is returned:\n' +
          '  "allstubs"         — IDs and names only for the DSD and all referenced objects.\n' +
          '  "referencestubs"   — Full detail for the DSD itself, stubs for linked objects.\n' +
          '  "referencepartial" — Full DSD + partial detail on references (codelists with codes but no hierarchy).\n' +
          '  "full"             — Complete DSD with all codes, hierarchies, and annotations. Default.',
      },
      references: {
        type: 'string',
        description:
          'Linked SDMX objects to embed in the response:\n' +
          '  "none"          — No referenced objects, only the DSD itself.\n' +
          '  "all"           — All referenced objects: codelists, concept schemes, etc. Default.\n' +
          '  "codelist"      — Only the codelists referenced by dimensions.\n' +
          '  "conceptscheme" — Only concept schemes.\n' +
          '  "datastructure" — Only the data structure itself (useful when called from /dataflow).',
      },
    },
    required: ['dataflow_id'],
  },
  execute: async (args: { dataflow_id: string; version?: string; detail?: string; references?: string }) => {
    const version = args.version ?? '1.0';
    const detail = args.detail ?? 'full';
    const references = args.references ?? 'all';
    const raw = await adeGet(
      `/datastructure/${AGENCY}/${encodeURIComponent(args.dataflow_id)}/${version}`,
      { references, detail },
    );

    if (typeof raw === 'string') {
      const parsed = parseDataflowInfoFromXml(raw);
      const payload = {
        dataflow_id: args.dataflow_id,
        version,
        detail,
        references,
        dimensions: parsed.dimensions,
        codelists: parsed.codelists,
      };
      return JSON.stringify(payload, null, 2);
    }

    return JSON.stringify({
      dataflow_id: args.dataflow_id,
      version,
      detail,
      references,
      raw,
    }, null, 2);
  },
  tags: ['stats-nz', 'metadata', 'new-zealand'],
});

const getStructureTool = weaveTool({
  name: 'statsnz_get_structure',
  description:
    'Get a composite structure bundle for a Stats NZ dataflow (dataflow + datastructure + codelists and related artefacts). ' +
    'Useful as a one-shot schema call before querying observations.',
  parameters: {
    type: 'object',
    properties: {
      dataflow_id: {
        type: 'string',
        description: 'The dataflow ID, e.g. "AGR_AGR_001". Returns the full structure bundle for this flow.',
      },
      version: {
        type: 'string',
        description: 'Version string. Default: "1.0". Use "latest" for the most recent version.',
      },
      detail: {
        type: 'string',
        enum: ['allstubs', 'referencestubs', 'referencepartial', 'full'],
        description:
          'Controls how much structural metadata is returned:\n' +
          '  "allstubs"         — IDs and names only.\n' +
          '  "referencestubs"   — Full dataflow, stubs for linked objects.\n' +
          '  "referencepartial" — Full dataflow + partial detail on references.\n' +
          '  "full"             — Complete structure with all codes. Default.',
      },
      references: {
        type: 'string',
        description:
          'Linked SDMX objects to include:\n' +
          '  "none"     — Dataflow definition only.\n' +
          '  "all"      — Dataflow + DSD + codelists + concept schemes. Default.\n' +
          '  "codelist" — Dataflow + only its codelists.',
      },
    },
    required: ['dataflow_id'],
  },
  execute: async (args: { dataflow_id: string; version?: string; detail?: string; references?: string }) => {
    const version = args.version ?? '1.0';
    const detail = args.detail ?? 'full';
    const references = args.references ?? 'all';
    // NOTE: The /structure/{agency}/{id} endpoint returns HTTP 501 "Not Implemented" on Stats NZ ADE.
    // Calling /dataflow/{agency}/{id}/{version}?references=all returns an equivalent structure bundle.
    const raw = await adeGet(
      `/dataflow/${AGENCY}/${encodeURIComponent(args.dataflow_id)}/${version}`,
      { references, detail },
    );

    if (typeof raw === 'string') {
      const parsedFlows = parseDataflowsFromXml(raw);
      const parsedDetails = parseDataflowInfoFromXml(raw);
      return JSON.stringify({
        dataflow_id: args.dataflow_id,
        version,
        detail,
        references,
        flowCount: parsedFlows.length,
        flows: parsedFlows,
        dimensions: parsedDetails.dimensions,
        codelists: parsedDetails.codelists,
      }, null, 2);
    }

    return JSON.stringify({
      dataflow_id: args.dataflow_id,
      version,
      detail,
      references,
      raw,
    }, null, 2);
  },
  tags: ['stats-nz', 'metadata', 'new-zealand'],
});

const getActualConstraintTool = weaveTool({
  name: 'statsnz_get_actualconstraint',
  description:
    'Get actual constraints for a Stats NZ dataflow (which dimension combinations currently have observations). ' +
    'Use this to avoid querying empty slices.',
  parameters: {
    type: 'object',
    properties: {
      dataflow_id: {
        type: 'string',
        description:
          'The dataflow ID, e.g. "AGR_AGR_001". The constraint object is automatically ' +
          'looked up as CR_A_{dataflow_id} (Stats NZ naming convention).',
      },
      version: {
        type: 'string',
        description: 'Version string. Default: "1.0".',
      },
      detail: {
        type: 'string',
        enum: ['allstubs', 'referencestubs', 'referencepartial', 'full'],
        description:
          'Detail level for the constraint response:\n' +
          '  "allstubs" — Just IDs and names.\n' +
          '  "full"     — Full constraint with all CubeRegion/KeyValue entries. Default.',
      },
      references: {
        type: 'string',
        description: 'Linked objects to include. "all" embeds the DSD and codelists. Default: all.',
      },
    },
    required: ['dataflow_id'],
  },
  execute: async (args: { dataflow_id: string; version?: string; detail?: string; references?: string }) => {
    const version = args.version ?? '1.0';
    const detail = args.detail ?? 'full';
    const references = args.references ?? 'all';
    // Stats NZ names actual constraints CR_A_{dataflow_id} — e.g. AGR_AGR_001 → CR_A_AGR_AGR_001.
    // Using the bare dataflow ID returns HTTP 404.
    const constraintId = `CR_A_${args.dataflow_id}`;
    const raw = await adeGet(
      `/actualconstraint/${AGENCY}/${encodeURIComponent(constraintId)}/${version}`,
      { references, detail },
    );

    if (typeof raw === 'string') {
      const summary = parseConstraintSummaryFromXml(raw);
      const preview = raw.length > 15_000 ? `${raw.slice(0, 15_000)}\n\n[XML truncated at 15,000 characters.]` : raw;
      return JSON.stringify({
        dataflow_id: args.dataflow_id,
        version,
        detail,
        references,
        summary,
        rawXmlPreview: preview,
      }, null, 2);
    }

    return JSON.stringify({
      dataflow_id: args.dataflow_id,
      version,
      detail,
      references,
      raw,
    }, null, 2);
  },
  tags: ['stats-nz', 'metadata', 'new-zealand'],
});

const getCodelistTool = weaveTool({
  name: 'statsnz_get_codelist',
  description:
    'Retrieve the codes and labels for a Stats NZ dimension codelist. ' +
    'Useful for finding valid filter values to use in statsnz_get_data.',
  parameters: {
    type: 'object',
    properties: {
      codelist_id: {
        type: 'string',
        description:
          'The codelist ID to retrieve. Obtain this from the "codelistID" field returned by ' +
          'statsnz_get_datastructure or statsnz_get_dataflow_info. Example: "CL_AREA_AGR_AGR_001" ' +
          '(the AREA dimension codelist for dataflow AGR_AGR_001).',
      },
      version: {
        type: 'string',
        description: 'Version string. Default: "1.0". Use "latest" for the most recent version.',
      },
    },
    required: ['codelist_id'],
  },
  execute: async (args: { codelist_id: string; version?: string }) => {
    const version = args.version ?? '1.0';
    const raw = await adeGet(
      `/codelist/${AGENCY}/${encodeURIComponent(args.codelist_id)}/${version}`,
      { detail: 'full' },
    );

    if (typeof raw === 'string') {
      const cl = parseCodelistFromXml(raw);
      if (!cl) return JSON.stringify({ error: `Codelist ${args.codelist_id} not found.` });
      return JSON.stringify({
        codelist_id: args.codelist_id,
        name: cl.name,
        count: cl.codeCount,
        codes: cl.codes ?? [],
      }, null, 2);
    }

    const json = raw as SdmxJsonResponse;
    const cl = json?.data?.codelists?.[0];
    if (!cl) return JSON.stringify({ error: `Codelist ${args.codelist_id} not found.` });

    const codes = (cl.codes ?? []).map((c) => ({ code: c.id, label: parseName(c.names) }));
    return JSON.stringify({
      codelist_id: args.codelist_id,
      name: parseName(cl.names),
      count: codes.length,
      codes,
    }, null, 2);
  },
  tags: ['stats-nz', 'metadata', 'new-zealand'],
});

const getDataTool = weaveTool({
  name: 'statsnz_get_data',
  description:
    'Fetch observations from a Stats NZ Aotearoa Data Explorer dataset. Returns up to 500 decoded ' +
    'observations with dimension codes and values. Use statsnz_get_datastructure to discover dimensions, ' +
    'statsnz_get_codelist to find valid filter codes, and statsnz_get_actualconstraint to check which ' +
    'dimension combinations have data before querying.',
  parameters: {
    type: 'object',
    properties: {
      dataflow_id: {
        type: 'string',
        description: 'The dataflow ID of the table to query, e.g. "AGR_AGR_001".',
      },
      version: {
        type: 'string',
        description: 'Dataflow version. Default: "1.0". Use "latest" for the most recent.',
      },
      key: {
        type: 'string',
        description:
          'Dimension filter key — dot-separated slots, one per dimension in DSD order.\n' +
          '  "all"           → no filter, return every observation.\n' +
          '  "6050.1.2018"   → dimension-1=6050, dimension-2=1, dimension-3=2018.\n' +
          '  "6050+7010.1."  → dimension-1 is 6050 OR 7010; empty slot means all values for that dimension.\n' +
          'Use statsnz_get_datastructure to find dimension order and statsnz_get_codelist for valid codes.',
      },
      format: {
        type: 'string',
        enum: ['jsondata', 'xml', 'structurespecificdata', 'csv', 'csvfile'],
        description:
          'Response format:\n' +
          '  "jsondata"              — SDMX-JSON v2 (recommended, decoded to plain objects). Default.\n' +
          '  "xml"                   — SDMX-ML GenericData (verbose XML).\n' +
          '  "structurespecificdata" — SDMX-ML StructureSpecificData (compact XML, needs DSD knowledge).\n' +
          '  "csv"                   — CSV text.\n' +
          '  "csvfile"               — CSV as an attachment.',
      },
      dimension_at_observation: {
        type: 'string',
        description:
          'Which dimension appears at the observation (leaf) level in the SDMX response structure.\n' +
          '  "AllDimensions" — All dimensions are on each observation; produces a flat observations map\n' +
          '                    keyed "d0:d1:d2" (position indices into each dimension value list). Default.\n' +
          '                    REQUIRED for Stats NZ ADE — omitting it causes HTTP 500 "languageTag1".\n' +
          '  "TIME_PERIOD"   — Time is at observation level; other dimensions form a series key\n' +
          '                    (standard SDMX time-series format, not supported by Stats NZ ADE).',
      },
      detail: {
        type: 'string',
        description:
          'Controls how much metadata is embedded alongside observation values:\n' +
          '  "full"           — Observation values + all attributes + codelists in structures. Default.\n' +
          '  "dataonly"       — Observation values only, no attributes (smaller response).\n' +
          '  "serieskeysonly" — Series keys only, no values (useful for exploring dimension coverage).\n' +
          '  "nodata"         — Structure metadata only, zero observations.',
      },
      start_period: {
        type: 'string',
        description:
          'Start of the time filter (inclusive). Format matches the TIME_PERIOD dimension frequency:\n' +
          '  Annual    → "2020"\n' +
          '  Quarterly → "2020-Q1"\n' +
          '  Monthly   → "2020-01"',
      },
      end_period: {
        type: 'string',
        description: 'End of the time filter (inclusive). Same format as start_period.',
      },
    },
    required: ['dataflow_id'],
  },
  execute: async (args: {
    dataflow_id: string;
    version?: string;
    key?: string;
    // 'jsondata' = SDMX-JSON v2 (decoded); 'xml' = SDMX-ML GenericData; 'csv'/'csvfile' = CSV
    format?: 'jsondata' | 'xml' | 'structurespecificdata' | 'csv' | 'csvfile';
    // 'AllDimensions' (default/required) or a specific dimension ID like 'TIME_PERIOD'
    dimension_at_observation?: string;
    // 'full' | 'dataonly' | 'serieskeysonly' | 'nodata'
    detail?: string;
    start_period?: string;
    end_period?: string;
  }) => {
    const version = args.version ?? '1.0';
    const requestedKey = args.key ?? 'all';
    let effectiveKey = requestedKey;
    const format = args.format ?? 'jsondata';

    // AllDimensions is required — without it Stats NZ ADE returns HTTP 500 "languageTag1".
    // With AllDimensions, every observation carries its full dimension key rather than being
    // grouped under a series object. This produces a flat observations map in SDMX-JSON v2.
    const dimAtObs = args.dimension_at_observation ?? 'AllDimensions';
    const params: Record<string, string> = { format, detail: args.detail ?? 'full', dimensionAtObservation: dimAtObs };
    if (args.start_period) params['startPeriod'] = args.start_period;
    if (args.end_period) params['endPeriod'] = args.end_period;

    const dataPath = (key: string) => `/data/${AGENCY},${encodeURIComponent(args.dataflow_id)},${version}/${encodeURIComponent(key)}`;

    // URL structure: /data/{agency},{flowId},{version}/{key}
    // key = "all" or dot-separated dimension filter (e.g. "6050.1.2018")
    // Defensive retry: some malformed-key paths on ADE can return HTTP 500 "languageTag1".
    // When detected, force the known-safe SDMX JSON settings and fall back to key=all.
    let raw: unknown;
    try {
      raw = await adeGet(dataPath(effectiveKey), params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isLanguageTagError = message.toLowerCase().includes('languagetag1');
      if (!isLanguageTagError) throw error;

      const safeParams: Record<string, string> = {
        format: 'jsondata',
        detail: 'full',
        dimensionAtObservation: 'AllDimensions',
      };
      if (args.start_period) safeParams['startPeriod'] = args.start_period;
      if (args.end_period) safeParams['endPeriod'] = args.end_period;

      try {
        raw = await adeGet(dataPath(effectiveKey), safeParams);
      } catch (retryError) {
        // Final retry with key=all to avoid malformed key combinations generated by LLM plans.
        effectiveKey = 'all';
        raw = await adeGet(dataPath(effectiveKey), safeParams);
      }
    }

    if (format !== 'jsondata') {
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (text.length > 50_000) {
        return `${text.slice(0, 50_000)}\n\n[Response truncated at 50,000 characters. Use more specific filters.]`;
      }
      return text;
    }

    // SDMX-JSON v2 structure (format=jsondata, dimensionAtObservation=AllDimensions):
    //   data.dataSets[]                                    — one dataset per dataflow (usually one)
    //   data.dataSets[].observations                       — map of "d0:d1:d2" → [obsValue, attr0, ...]
    //   data.structures[].dimensions.observation[]         — dimension descriptors in key order
    //   data.structures[].dimensions.observation[i].values — the codelist for dimension i
    //   obs value = vals[0]; vals[1+] are attribute index values (e.g. OBS_STATUS index)
    const data = raw as Record<string, unknown>;
    const sdmxData = data?.['data'] as Record<string, unknown> | undefined;
    const dataSets = (sdmxData?.['dataSets'] as unknown[]) ?? [];

    // Extract dimension descriptors so we can decode the "d0:d1:d2" observation keys.
    const structures = (sdmxData?.['structures'] as unknown[]) ?? [];
    const firstStruct = structures[0] as Record<string, unknown> | undefined;
    const dims = firstStruct?.['dimensions'] as Record<string, unknown> | undefined;
    const obsDimensions = (dims?.['observation'] as unknown[] | undefined) ?? [];
    // dimensionIds[i]    → the SDMX dimension ID string (e.g. "AREA_AGR_AGR_001")
    const dimensionIds = obsDimensions.map((d) => (d as Record<string, unknown>)['id'] as string);
    // dimensionValues[i] → array of { id: "code", name: "label" } for dimension i
    const dimensionValues = obsDimensions.map((d) => {
      return ((d as Record<string, unknown>)['values'] as unknown[] | undefined) ?? [];
    });

    // Decode up to MAX_OBS observations into plain objects:
    //   { AREA_AGR_AGR_001: "1", YEAR_AGR_AGR_001: "2018", ..., value: 332 }
    // Observation key "0:1:2" → indices [0,1,2] → look up code ID in each dimension's values array.
    const MAX_OBS = 500;
    const decodedObservations: Record<string, unknown>[] = [];
    let observationCount = 0;

    for (const ds of dataSets) {
      const rawObs = (ds as Record<string, unknown>)?.['observations'] as Record<string, unknown[]> | undefined;
      if (!rawObs) continue;
      for (const [obsKey, vals] of Object.entries(rawObs)) {
        observationCount++;
        if (decodedObservations.length < MAX_OBS) {
          // Split "0:1:2" into [0,1,2] and resolve each index to its dimension code ID
          const indices = obsKey.split(':').map(Number);
          const obs: Record<string, unknown> = {};
          indices.forEach((idx, pos) => {
            const dimId = dimensionIds[pos] ?? `dim${pos}`;
            const dimVal = dimensionValues[pos]?.[idx] as Record<string, unknown> | undefined;
            obs[dimId] = dimVal?.['id'] ?? idx;
          });
          obs['value'] = vals[0]; // vals[0] is the numeric/string observation value
          decodedObservations.push(obs);
        }
      }
    }

    const summary = {
      dataflow_id: args.dataflow_id,
      version,
      key: effectiveKey,
      requested_key: requestedKey,
      format,
      // Total observation count across all dataSets in the response
      observationCount,
      // true when observationCount > MAX_OBS — use a narrower key or period filter to see all data
      truncated: observationCount > MAX_OBS,
      // SDMX dimension IDs in key order (matches the dot-separated positions in the key parameter)
      dimensions: dimensionIds,
      // Decoded observations (up to MAX_OBS)
      observations: decodedObservations,
    };

    return JSON.stringify(summary, null, 2);
  },
  tags: ['stats-nz', 'data', 'new-zealand'],
});

export function statsNzToolMap(): Record<string, Tool> {
  const tools: Tool[] = [
    listDataflowsTool,
    searchDataflowsTool,
    getDataflowInfoTool,
    getDatastructureTool,
    getStructureTool,
    getActualConstraintTool,
    getCodelistTool,
    getDataTool,
  ];
  return Object.fromEntries(tools.map((t) => [t.schema.name, t]));
}
