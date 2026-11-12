import { describe, expect, it } from 'vitest';
import { UnsupportedContentError, Capabilities } from '@weaveintel/core';
import { anthropicCapabilityProfile, buildAnthropicMessages, partToAnthropicBlock } from './anthropic-format.js';
import { determineCapabilities } from './anthropic-models.js';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

describe('Anthropic content parts: sent properly or refused, never a placeholder', () => {
  it('sends a PDF as a document block', () => {
    expect(partToAnthropicBlock({ type: 'file', base64: 'JVBERi0=', mimeType: 'application/pdf' })).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
    });
  });

  it('sends a text file as a plain-text document block', () => {
    expect(partToAnthropicBlock({ type: 'file', base64: b64('a,b\n1,2'), mimeType: 'text/csv', filename: 'x.csv' })).toEqual({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: 'a,b\n1,2' },
    });
  });

  it('sends an image file as an image block', () => {
    expect(partToAnthropicBlock({ type: 'file', base64: 'iVBO', mimeType: 'image/png' })).toMatchObject({ type: 'image' });
  });

  it('refuses audio naming audio_in', () => {
    let err: unknown;
    try { partToAnthropicBlock({ type: 'audio', base64: 'AAAA', mimeType: 'audio/wav' }, { modelId: 'claude-sonnet-4-6' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnsupportedContentError);
    expect(err).toMatchObject({ code: 'UNSUPPORTED_CONTENT', capability: 'audio_in' });
    expect((err as Error).message).toBe('anthropic claude-sonnet-4-6 cannot read audio; the content was not sent.');
  });

  it('refuses a DOCX naming the document type', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(() => partToAnthropicBlock({ type: 'file', base64: 'UEsD', mimeType: docx })).toThrow(UnsupportedContentError);
    try { partToAnthropicBlock({ type: 'file', base64: 'UEsD', mimeType: docx }); } catch (e) {
      expect((e as UnsupportedContentError).capability).toBe(`document:${docx}`);
    }
  });

  it('refuses an unsupported image type and a text file sent as a link', () => {
    expect(() => partToAnthropicBlock({ type: 'image', base64: 'x', mimeType: 'image/tiff' })).toThrow(/image\/tiff/);
    expect(() => partToAnthropicBlock({ type: 'file', url: 'https://x/a.txt', mimeType: 'text/plain' })).toThrow(/not a link/);
  });

  it('never produces placeholder text anywhere in a mixed message', () => {
    const { messages } = buildAnthropicMessages([
      { role: 'user', content: [{ type: 'text', text: 'read' }, { type: 'file', base64: 'JVBERi0=', mimeType: 'application/pdf' }] },
    ]);
    expect(JSON.stringify(messages)).not.toMatch(/\[file|content\]|not supported/);
  });

  it('declares PDF and text documents for Claude models', () => {
    expect(determineCapabilities('claude-sonnet-4-6')).toContain(Capabilities.PdfInput);
    const p = anthropicCapabilityProfile('claude-sonnet-4-6');
    expect(p).toMatchObject({ vision: true, pdf: true, audioIn: false, toolUse: true, documentMimeTypes: ['text/*'] });
  });
});
