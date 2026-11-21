// SPDX-License-Identifier: MIT
// File understanding: ports, in-house readers, model-backed engines, validation, mapping, cache, service.
export * from './types.js';
export * from './ports.js';
export { FileLimitError } from './errors.js';
export { MIME, sniffMimeType, type SniffResult } from './sniff.js';
export { readZip, looksLikeZip, writeZip, type ZipArchive, type ZipEntry, type ZipLimits } from './zip.js';
export { parseXml, decodeEntities, type XmlElement } from './xml.js';
export { parseDocx, createDocxParser, type DocxOptions } from './docx.js';
export { parseXlsx, createXlsxParser, cellRef, excelSerialToIso, findHeaderRow, type XlsxOptions } from './xlsx.js';
export {
  parseEmail,
  createEmailParser,
  createPostalMimeParser,
  createTextParser,
  htmlToText,
  parseCsv,
  decodeEncodedWords,
  headerParams,
  decodeText,
  type EmailLimits,
  type ParsedEmail,
  type PostalMimeLike,
} from './email.js';
export { parsePdfBasic, createBasicPdfParser, createPdfJsParser, parseToUnicode, pdfActiveContent, type BasicPdfOptions, type PdfJsLike } from './pdf.js';
export { createDoclingServeEngine, doclingJsonToPages, type DoclingServeOptions, type FetchLike } from './docling.js';
export { buildExtractionSchema, rawValuesFromAnswer, validateValues, normaliseForMatch, assertFieldDefinitions, type ValidationOptions } from './schema.js';
export {
  createModelFieldExtractor,
  createModelClassifier,
  createModelVisionReader,
  createModelOcr,
  createAudioModelSpeechToText,
  createEmbeddingModelEmbedder,
  schemaRequest,
  parseJsonAnswer,
  type ModelFieldExtractorOptions,
} from './engines.js';
export {
  mapColumns,
  applyMapping,
  applyTransform,
  inferTransform,
  cosine,
  TRANSFORMS,
  type Transform,
  type SourceColumn,
  type ColumnMapping,
  type MappingResult,
  type MapColumnsOptions,
  type RowError,
} from './mapping.js';
export { contentHash, resultCacheKey, createMemoryResultCache, type CacheKeyParts } from './cache.js';
export { createFileUnderstanding, defaultParsers, type FileUnderstanding, type FileUnderstandingOptions, type UnderstandOptions } from './service.js';
export {
  createStandInModel,
  createStandInEmbedder,
  createStandInOcr,
  createStandInVision,
  createStandInSpeech,
  requestText,
  type StandInModel,
} from './stand-ins.js';
