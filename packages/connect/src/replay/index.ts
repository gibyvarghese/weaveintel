// SPDX-License-Identifier: MIT
/**
 * @weaveintel/connect/replay — record-and-replay exchanges for connector tests, with scrubbing.
 * Recording (`createRecordingSend`) runs only with CONNECT_RECORD=1.
 */
export { checkRecording, createReplaySend, findSecrets, scrub, type Exchange, type RecordedRequest, type Recording, type ReplaySend } from './replay.js'
export { RECORDED_HEADERS, REPLAY_RUN_REF, createRecordingSend, recordingEnabled, replayIdempotencyKey, type RecordingOptions, type RecordingSend, type SaveResult } from './record.js'
