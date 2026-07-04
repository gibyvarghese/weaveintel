// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { buildImageGenerationBody, isGptImageModel } from './openai-images.js';

describe('isGptImageModel', () => {
  it('recognises the GPT Image family, not DALL·E', () => {
    expect(isGptImageModel('gpt-image-1')).toBe(true);
    expect(isGptImageModel('gpt-image-2')).toBe(true);
    expect(isGptImageModel('GPT-Image-1')).toBe(true);
    expect(isGptImageModel('dall-e-3')).toBe(false);
    expect(isGptImageModel('dall-e-2')).toBe(false);
  });
});

describe('buildImageGenerationBody — model-aware params', () => {
  it('GPT Image NEVER sends response_format (the bug that returned "Unknown parameter: response_format" / no image)', () => {
    const body = buildImageGenerationBody('gpt-image-1', { prompt: 'a red circle', size: '1024x1024', quality: 'low', n: 1 });
    expect(body).not.toHaveProperty('response_format'); // the fix
    expect(body['model']).toBe('gpt-image-1');
    expect(body['prompt']).toBe('a red circle');
    expect(body['size']).toBe('1024x1024');
    expect(body['quality']).toBe('low');
    expect(body['n']).toBe(1);
  });

  it('GPT Image supports its own params (background, output_format, output_compression, moderation)', () => {
    const body = buildImageGenerationBody('gpt-image-1', {
      prompt: 'a logo', background: 'transparent', outputFormat: 'webp', outputCompression: 80, moderation: 'low',
    });
    expect(body['background']).toBe('transparent');
    expect(body['output_format']).toBe('webp');
    expect(body['output_compression']).toBe(80);
    expect(body['moderation']).toBe('low');
    expect(body).not.toHaveProperty('response_format');
    // GPT Image ignores DALL·E-only 'style'.
    expect(body).not.toHaveProperty('style');
  });

  it('DALL·E DOES send response_format=b64_json + supports style', () => {
    const body = buildImageGenerationBody('dall-e-3', { prompt: 'a painting', style: 'vivid', quality: 'hd' });
    expect(body['response_format']).toBe('b64_json'); // DALL·E accepts it
    expect(body['style']).toBe('vivid');
    expect(body['quality']).toBe('hd');
    // DALL·E ignores GPT-Image-only params.
    expect(body).not.toHaveProperty('background');
    expect(body).not.toHaveProperty('output_format');
  });

  it('omits optional params when not provided', () => {
    const body = buildImageGenerationBody('gpt-image-1', { prompt: 'x' });
    expect(Object.keys(body).sort()).toEqual(['model', 'prompt']);
  });
});
