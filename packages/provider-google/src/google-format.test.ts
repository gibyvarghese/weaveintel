import { describe, expect, it } from 'vitest';
import { UnsupportedContentError } from '@weaveintel/core';
import { buildGeminiRequest, partToGeminiPart } from './google-format.js';

describe('Gemini parts: sent properly or refused, never empty or dropped', () => {
  it('sends PDF, text, image and audio inline', () => {
    expect(partToGeminiPart({ type: 'file', base64: 'JVBERi0=', mimeType: 'application/pdf' })).toEqual({ inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } });
    expect(partToGeminiPart({ type: 'file', base64: 'YQ==', mimeType: 'text/csv' })).toEqual({ inlineData: { mimeType: 'text/csv', data: 'YQ==' } });
    expect(partToGeminiPart({ type: 'audio', base64: 'UklG' })).toEqual({ inlineData: { mimeType: 'audio/wav', data: 'UklG' } });
    expect(partToGeminiPart({ type: 'image', url: 'gs://b/x.png', mimeType: 'image/png' })).toEqual({ fileData: { mimeType: 'image/png', fileUri: 'gs://b/x.png' } });
  });

  it('refuses Office files, empty parts and odd links', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(() => partToGeminiPart({ type: 'file', base64: 'UEsD', mimeType: docx })).toThrow(UnsupportedContentError);
    expect(() => partToGeminiPart({ type: 'file', mimeType: 'application/pdf' })).toThrow(/no content/);
    expect(() => partToGeminiPart({ type: 'image', url: 'data:image/png;base64,xx' })).toThrow(/http\(s\) or gs/);
  });

  it('refuses a file in a system instruction instead of dropping it', () => {
    expect(() => buildGeminiRequest({ messages: [{ role: 'system', content: [{ type: 'text', text: 'x' }, { type: 'file', base64: 'x', mimeType: 'application/pdf' }] }] }))
      .toThrow(/only text/);
  });
});
