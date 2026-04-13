/**
 * @weaveintel/tools-social — MCP tool factory tests
 *
 * Tests createSocialTools generates the correct number and naming of tools.
 */
import { describe, it, expect } from 'vitest';
import { createSocialTools } from '../mcp.js';
import type { SocialAccountConfig } from '../types.js';

describe('createSocialTools', () => {
  it('returns empty array for no configs', () => {
    const tools = createSocialTools([]);
    expect(tools).toHaveLength(0);
  });

  it('skips disabled configs', () => {
    const configs: SocialAccountConfig[] = [{
      platform: 'slack', accountName: 'test', enabled: false,
      authType: 'bearer', accessToken: 'tok',
    }];
    const tools = createSocialTools(configs);
    expect(tools).toHaveLength(0);
  });

  it('generates 3 base tools for slack', () => {
    const configs: SocialAccountConfig[] = [{
      platform: 'slack', accountName: 'team', enabled: true,
      authType: 'bearer', accessToken: 'tok',
    }];
    const tools = createSocialTools(configs);
    expect(tools).toHaveLength(3);
    const names = tools.map(t => t.schema.name);
    expect(names).toContain('social.slack.search');
    expect(names).toContain('social.slack.post');
    expect(names).toContain('social.slack.profile');
  });

  it('generates 3 base tools for discord', () => {
    const configs: SocialAccountConfig[] = [{
      platform: 'discord', accountName: 'server', enabled: true,
      authType: 'bearer', accessToken: 'tok',
    }];
    const tools = createSocialTools(configs);
    expect(tools).toHaveLength(3);
  });

  it('generates 3 base tools for github', () => {
    const configs: SocialAccountConfig[] = [{
      platform: 'github', accountName: 'org', enabled: true,
      authType: 'bearer', accessToken: 'tok',
    }];
    const tools = createSocialTools(configs);
    expect(tools).toHaveLength(3);
  });

  it('generates Facebook tools: 3 base + 12 extended = 15', () => {
    const configs: SocialAccountConfig[] = [{
      platform: 'facebook', accountName: 'page', enabled: true,
      authType: 'bearer', accessToken: 'tok',
    }];
    const tools = createSocialTools(configs);
    expect(tools).toHaveLength(15);

    const names = tools.map(t => t.schema.name);
    // base tools
    expect(names).toContain('social.facebook.search');
    expect(names).toContain('social.facebook.post');
    expect(names).toContain('social.facebook.profile');
    // extended tools
    expect(names).toContain('social.facebook.getPost');
    expect(names).toContain('social.facebook.updatePost');
    expect(names).toContain('social.facebook.deletePost');
    expect(names).toContain('social.facebook.comments');
    expect(names).toContain('social.facebook.addComment');
    expect(names).toContain('social.facebook.deleteComment');
    expect(names).toContain('social.facebook.photos');
    expect(names).toContain('social.facebook.publishPhoto');
    expect(names).toContain('social.facebook.videos');
    expect(names).toContain('social.facebook.insights');
    expect(names).toContain('social.facebook.page');
    expect(names).toContain('social.facebook.pageToken');
  });

  it('generates Instagram tools: 3 base + 10 extended = 13', () => {
    const configs: SocialAccountConfig[] = [{
      platform: 'instagram', accountName: 'biz', enabled: true,
      authType: 'bearer', accessToken: 'tok',
    }];
    const tools = createSocialTools(configs);
    expect(tools).toHaveLength(13);

    const names = tools.map(t => t.schema.name);
    // base tools
    expect(names).toContain('social.instagram.search');
    expect(names).toContain('social.instagram.post');
    expect(names).toContain('social.instagram.profile');
    // extended tools
    expect(names).toContain('social.instagram.getMedia');
    expect(names).toContain('social.instagram.comments');
    expect(names).toContain('social.instagram.replyComment');
    expect(names).toContain('social.instagram.deleteComment');
    expect(names).toContain('social.instagram.hideComment');
    expect(names).toContain('social.instagram.stories');
    expect(names).toContain('social.instagram.mediaInsights');
    expect(names).toContain('social.instagram.userInsights');
    expect(names).toContain('social.instagram.searchHashtag');
    expect(names).toContain('social.instagram.hashtagMedia');
  });

  it('generates combined tools from multiple configs', () => {
    const configs: SocialAccountConfig[] = [
      { platform: 'slack', accountName: 's', enabled: true, authType: 'bearer', accessToken: 'a' },
      { platform: 'facebook', accountName: 'fb', enabled: true, authType: 'bearer', accessToken: 'b' },
      { platform: 'instagram', accountName: 'ig', enabled: true, authType: 'bearer', accessToken: 'c' },
    ];
    const tools = createSocialTools(configs);
    // 3 + 15 + 13 = 31
    expect(tools.length).toBe(31);
  });

  it('skips unknown platforms when no matching provider', () => {
    const configs: SocialAccountConfig[] = [{
      platform: 'tiktok', accountName: 'x', enabled: true,
      authType: 'bearer', accessToken: 'tok',
    }];
    const tools = createSocialTools(configs);
    expect(tools).toHaveLength(0);
  });

  it('all tools have schema with name, description, parameters, and invoke', () => {
    const configs: SocialAccountConfig[] = [{
      platform: 'facebook', accountName: 'test', enabled: true,
      authType: 'bearer', accessToken: 'tok',
    }];
    const tools = createSocialTools(configs);
    for (const tool of tools) {
      expect(tool.schema.name).toBeTruthy();
      expect(tool.schema.description).toBeTruthy();
      expect(tool.schema.parameters).toBeDefined();
      expect(typeof tool.invoke).toBe('function');
    }
  });
});
