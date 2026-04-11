import type { DocumentInput, ExtractionResult, ExtractionStage, ExtractedTimeline } from '@weaveintel/core';
import type { StageProcessor } from '../pipeline.js';

export interface TimelineStageConfig {
  id?: string;
  enabled?: boolean;
  order?: number;
}

interface RawEvent {
  date: string;
  sortKey: string;
  description: string;
  confidence: number;
}

const MONTH_MAP: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

const ISO_DATE_LINE = /(\d{4}-\d{2}-\d{2})[\s:,\-–—]*(.+)/g;
const MONTH_YEAR_LINE = /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})[\s:,\-–—]*(.+)/gi;
const MONTH_ONLY_LINE = /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})[\s:,\-–—]*(.+)/gi;
const QUARTER_LINE = /(Q[1-4]\s+\d{4})[\s:,\-–—]*(.+)/gi;

function parseMonthYearToSort(dateStr: string): string {
  const parts = dateStr.replace(',', '').split(/\s+/);
  if (parts.length === 3) {
    const month = MONTH_MAP[parts[0]!.toLowerCase()] ?? '01';
    const day = parts[1]!.padStart(2, '0');
    return `${parts[2]}-${month}-${day}`;
  }
  if (parts.length === 2) {
    const month = MONTH_MAP[parts[0]!.toLowerCase()] ?? '01';
    return `${parts[1]}-${month}-01`;
  }
  return dateStr;
}

function parseQuarterToSort(qStr: string): string {
  const match = /Q([1-4])\s+(\d{4})/.exec(qStr);
  if (!match) return qStr;
  const quarterMonth = String((parseInt(match[1]!, 10) - 1) * 3 + 1).padStart(2, '0');
  return `${match[2]}-${quarterMonth}-01`;
}

export function createTimelineStage(config?: TimelineStageConfig): StageProcessor {
  const stage: ExtractionStage = {
    id: config?.id ?? 'timeline',
    name: 'Timeline Extraction',
    type: 'timeline',
    enabled: config?.enabled ?? true,
    order: config?.order ?? 6,
  };

  function process(input: DocumentInput, result: ExtractionResult): ExtractionResult {
    const text = typeof input.content === 'string' ? input.content : input.content.toString('utf-8');
    const events: RawEvent[] = [];

    // ISO dates
    let regex = new RegExp(ISO_DATE_LINE.source, ISO_DATE_LINE.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      events.push({
        date: match[1]!,
        sortKey: match[1]!,
        description: match[2]!.trim(),
        confidence: 0.95,
      });
    }

    // "January 15, 2024 — Description"
    regex = new RegExp(MONTH_YEAR_LINE.source, MONTH_YEAR_LINE.flags);
    while ((match = regex.exec(text)) !== null) {
      events.push({
        date: match[1]!,
        sortKey: parseMonthYearToSort(match[1]!),
        description: match[2]!.trim(),
        confidence: 0.85,
      });
    }

    // "January 2024 — Description"
    regex = new RegExp(MONTH_ONLY_LINE.source, MONTH_ONLY_LINE.flags);
    while ((match = regex.exec(text)) !== null) {
      // Skip if already matched by MONTH_YEAR_LINE (has day component)
      if (/\d{1,2},?\s+\d{4}$/.test(match[1]!.trim())) continue;
      events.push({
        date: match[1]!,
        sortKey: parseMonthYearToSort(match[1]!),
        description: match[2]!.trim(),
        confidence: 0.8,
      });
    }

    // "Q1 2025 — Description"
    regex = new RegExp(QUARTER_LINE.source, QUARTER_LINE.flags);
    while ((match = regex.exec(text)) !== null) {
      events.push({
        date: match[1]!,
        sortKey: parseQuarterToSort(match[1]!),
        description: match[2]!.trim(),
        confidence: 0.75,
      });
    }

    // Sort chronologically by sortKey
    events.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    // Deduplicate by date + description
    const seen = new Set<string>();
    const uniqueEvents = events.filter((e) => {
      const key = `${e.date}::${e.description}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const timeline: ExtractedTimeline = {
      events: uniqueEvents.map((e) => ({
        date: e.date,
        description: e.description,
        confidence: e.confidence,
      })),
    };

    const existingEvents = result.timeline?.events ?? [];
    return {
      ...result,
      timeline: {
        events: [...existingEvents, ...timeline.events],
      },
    };
  }

  return { stage, process };
}
