// SPDX-License-Identifier: MIT
// File sources: links and cloud drives, with the identity that fetched each file and the source's permissions.
export * from './types.js';
export { createGuardedTransport, statusError, type SourceTransport, type SourceRequest, type SourceResponse, type GuardedTransportOptions, type LookupFn } from './transport.js';
export { createUrlSource, createICloudLinkSource, isICloudLink, type UrlSourceOptions, type DomainCredential } from './url.js';
export { createGraphSource, graphShareId, normaliseGraphPermissions, GRAPH_AUDIENCE, GRAPH_USER_SCOPES, GRAPH_SERVICE_SCOPES, type GraphSourceOptions } from './graph.js';
export { createGoogleDriveSource, driveFileId, normaliseDrivePermissions, DEFAULT_GOOGLE_EXPORTS, DRIVE_AUDIENCE, DRIVE_SCOPES, type GoogleDriveSourceOptions } from './gdrive.js';
export { createDropboxSource, createBoxSource, normaliseBoxCollaborations, type DropboxSourceOptions, type BoxSourceOptions } from './dropbox-box.js';
export { createMcpFileSource, createSourceResolver, createOnBehalfOfTokenProvider, type McpToolCaller, type McpFileSourceConfig, type SourceResolver, type ResolvedFile } from './mcp-resolver.js';
