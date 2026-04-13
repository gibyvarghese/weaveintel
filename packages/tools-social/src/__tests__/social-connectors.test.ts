/**
 * @weaveintel/tools-social — Facebook & Instagram connector tests
 *
 * Mirrors the fetch-mocking pattern used in the enterprise connector tests.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FacebookProvider } from '../platforms/facebook.js';
import { InstagramProvider } from '../platforms/instagram.js';
import type { SocialAccountConfig } from '../types.js';

/* ---------- helpers ---------- */

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const ok204 = () => new Response(null, { status: 204 });

function mockFetch(body: unknown) {
  const spy = vi.fn().mockResolvedValue(ok(body));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

const fbConfig: SocialAccountConfig = {
  platform: 'facebook',
  accountName: 'test-page',
  enabled: true,
  authType: 'bearer',
  accessToken: 'fb-tok',
  options: { pageId: 'pg123' },
};

const igConfig: SocialAccountConfig = {
  platform: 'instagram',
  accountName: 'ig-biz',
  enabled: true,
  authType: 'bearer',
  accessToken: 'ig-tok',
  options: { igUserId: 'ig456' },
};

/* ============================================================
   Facebook Provider
   ============================================================ */
describe('FacebookProvider', () => {
  const fb = new FacebookProvider();

  it('platform is facebook', () => {
    expect(fb.platform).toBe('facebook');
  });

  /* -- search (feed) -- */
  it('search calls page feed endpoint', async () => {
    const spy = mockFetch({ data: [{ id: '1', message: 'hello', from: { name: 'A', id: 'a1' }, created_time: '2024-01-01' }] });
    const res = await fb.search({ query: 'test', limit: 5 }, fbConfig);
    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe('1');
    expect(res[0]!.text).toBe('hello');
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('/pg123/feed');
    expect(url).toContain('limit=5');
  });

  /* -- post -- */
  it('post sends message to feed endpoint', async () => {
    const spy = mockFetch({ id: 'post_123' });
    const res = await fb.post({ text: 'hello world' }, fbConfig);
    expect(res.id).toBe('post_123');
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('/pg123/feed');
  });

  /* -- getProfile -- */
  it('getProfile fetches user fields', async () => {
    const spy = mockFetch({ id: 'u1', name: 'Test', email: 'a@b.com' });
    const res = await fb.getProfile('u1', fbConfig);
    expect(res['name']).toBe('Test');
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('/u1?fields=');
  });

  /* -- getPost -- */
  it('getPost returns a SocialPost', async () => {
    mockFetch({ id: 'p2', message: 'hi', from: { name: 'B' }, created_time: '2024-02-01' });
    const res = await fb.getPost('p2', fbConfig);
    expect(res.id).toBe('p2');
    expect(res.text).toBe('hi');
  });

  /* -- updatePost -- */
  it('updatePost POSTs to post URL', async () => {
    const spy = mockFetch({ success: true });
    await fb.updatePost('p3', 'new text', fbConfig);
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('/p3');
    const body = JSON.parse(spy.mock.calls[0]![1].body);
    expect(body.message).toBe('new text');
  });

  /* -- deletePost -- */
  it('deletePost sends DELETE', async () => {
    const spy = vi.fn().mockResolvedValue(ok204());
    vi.stubGlobal('fetch', spy);
    await fb.deletePost('p4', fbConfig);
    expect(spy.mock.calls[0]![1].method).toBe('DELETE');
  });

  /* -- comments -- */
  it('getComments fetches object comments', async () => {
    mockFetch({ data: [{ id: 'c1', message: 'nice', from: { name: 'C' }, created_time: '2024-01-01' }] });
    const res = await fb.getComments('obj1', fbConfig, 10);
    expect(res).toHaveLength(1);
    expect(res[0]!.text).toBe('nice');
  });

  it('addComment POSTs to comments edge', async () => {
    const spy = mockFetch({ id: 'c2' });
    const res = await fb.addComment('obj1', 'great post', fbConfig);
    expect(res.id).toBe('c2');
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('/obj1/comments');
  });

  it('deleteComment sends DELETE', async () => {
    const spy = vi.fn().mockResolvedValue(ok204());
    vi.stubGlobal('fetch', spy);
    await fb.deleteComment('c3', fbConfig);
    expect(spy.mock.calls[0]![1].method).toBe('DELETE');
  });

  /* -- photos -- */
  it('getPhotos returns data array', async () => {
    mockFetch({ data: [{ id: 'ph1', name: 'photo' }] });
    const res = await fb.getPhotos('pg123', fbConfig);
    expect(res).toHaveLength(1);
  });

  it('publishPhoto POSTs url and caption', async () => {
    const spy = mockFetch({ id: 'ph2' });
    await fb.publishPhoto('pg123', 'https://img.jpg', 'cap', fbConfig);
    const body = JSON.parse(spy.mock.calls[0]![1].body);
    expect(body.url).toBe('https://img.jpg');
    expect(body.caption).toBe('cap');
  });

  /* -- videos -- */
  it('getVideos fetches video list', async () => {
    mockFetch({ data: [{ id: 'v1', title: 'vid' }] });
    const res = await fb.getVideos('pg123', fbConfig);
    expect(res).toHaveLength(1);
  });

  /* -- insights -- */
  it('getInsights fetches page insights', async () => {
    const spy = mockFetch({ data: [{ name: 'page_views', values: [] }] });
    const res = await fb.getInsights('pg123', ['page_views'], 'day', fbConfig);
    expect(res).toHaveLength(1);
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('metric=page_views');
    expect(url).toContain('period=day');
  });

  /* -- page -- */
  it('getPage returns page info', async () => {
    mockFetch({ id: 'pg123', name: 'My Page', category: 'Brand' });
    const res = await fb.getPage('pg123', fbConfig);
    expect(res['name']).toBe('My Page');
  });

  /* -- auth headers -- */
  it('uses Bearer token in auth headers', async () => {
    const spy = mockFetch({ data: [] });
    await fb.search({ query: '' }, fbConfig);
    const headers = spy.mock.calls[0]![1].headers;
    expect(headers['Authorization']).toBe('Bearer fb-tok');
  });
});

/* ============================================================
   Instagram Provider
   ============================================================ */
describe('InstagramProvider', () => {
  const ig = new InstagramProvider();

  it('platform is instagram', () => {
    expect(ig.platform).toBe('instagram');
  });

  /* -- search (media feed) -- */
  it('search fetches user media feed', async () => {
    const spy = mockFetch({ data: [{ id: 'm1', caption: 'sunset', timestamp: '2024-01-01', username: 'me' }] });
    const res = await ig.search({ query: '', limit: 3 }, igConfig);
    expect(res).toHaveLength(1);
    expect(res[0]!.text).toBe('sunset');
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('/ig456/media');
    expect(url).toContain('limit=3');
  });

  /* -- post (container-based) -- */
  it('post creates container then publishes', async () => {
    let callCount = 0;
    const spy = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(ok({ id: 'container_1' }));
      return Promise.resolve(ok({ id: 'published_1' }));
    });
    vi.stubGlobal('fetch', spy);

    const res = await ig.post({ text: 'new post' }, igConfig);
    expect(spy).toHaveBeenCalledTimes(2);
    // first call: create container
    expect(String(spy.mock.calls[0]![0])).toContain('/ig456/media');
    // second call: publish
    expect(String(spy.mock.calls[1]![0])).toContain('/ig456/media_publish');
    expect(res.id).toBe('published_1');
  });

  it('post with video media sets REELS', async () => {
    let callCount = 0;
    const spy = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(ok({ id: `id_${callCount}` }));
    });
    vi.stubGlobal('fetch', spy);

    await ig.post({ text: 'vid', media: [{ type: 'VIDEO', url: 'https://v.mp4' }] }, igConfig);
    const body = JSON.parse(spy.mock.calls[0]![1].body);
    expect(body.media_type).toBe('REELS');
    expect(body.video_url).toBe('https://v.mp4');
  });

  /* -- getProfile -- */
  it('getProfile fetches IG user fields', async () => {
    const spy = mockFetch({ id: 'ig456', username: 'testuser', followers_count: 1000 });
    const res = await ig.getProfile('ig456', igConfig);
    expect(res['username']).toBe('testuser');
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('fields=id,username,name,biography');
  });

  /* -- getMedia -- */
  it('getMedia returns SocialPost', async () => {
    mockFetch({ id: 'm2', caption: 'beach', media_type: 'IMAGE', media_url: 'https://img.jpg', timestamp: '2024-01-01' });
    const res = await ig.getMedia('m2', igConfig);
    expect(res.id).toBe('m2');
    expect(res.text).toBe('beach');
    expect(res.media).toHaveLength(1);
  });

  /* -- comments -- */
  it('getComments fetches media comments', async () => {
    mockFetch({ data: [{ id: 'c1', text: 'cool', username: 'u1', timestamp: '2024-01-01' }] });
    const res = await ig.getComments('m1', igConfig);
    expect(res).toHaveLength(1);
    expect(res[0]!.text).toBe('cool');
  });

  it('replyToComment sends reply', async () => {
    const spy = mockFetch({ id: 'reply_1' });
    const res = await ig.replyToComment('c1', 'thanks', igConfig);
    expect(res.id).toBe('reply_1');
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('/c1/replies');
  });

  it('deleteComment sends DELETE', async () => {
    // Instagram deleteComment uses fetchRaw which is inherited from the provider
    // Need to check if it has its own fetchRaw or uses a different approach
    const spy = vi.fn().mockResolvedValue(ok204());
    vi.stubGlobal('fetch', spy);
    await ig.deleteComment('c2', igConfig);
    expect(spy.mock.calls[0]![1].method).toBe('DELETE');
  });

  it('hideComment POSTs hide flag', async () => {
    const spy = mockFetch({ success: true });
    await ig.hideComment('c3', true, igConfig);
    const body = JSON.parse(spy.mock.calls[0]![1].body);
    expect(body.hide).toBe(true);
  });

  /* -- stories -- */
  it('getStories fetches user stories', async () => {
    const spy = mockFetch({ data: [{ id: 's1', media_type: 'IMAGE', timestamp: '2024-01-01' }] });
    const res = await ig.getStories(igConfig);
    expect(res).toHaveLength(1);
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('/ig456/stories');
  });

  /* -- insights -- */
  it('getMediaInsights fetches metric data', async () => {
    const spy = mockFetch({ data: [{ name: 'impressions', values: [{ value: 100 }] }] });
    const res = await ig.getMediaInsights('m1', ['impressions'], igConfig);
    expect(res).toHaveLength(1);
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('metric=impressions');
  });

  it('getUserInsights fetches account insights', async () => {
    const spy = mockFetch({ data: [{ name: 'reach' }] });
    const res = await ig.getUserInsights(['reach'], 'day', igConfig);
    expect(res).toHaveLength(1);
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('/ig456/insights');
    expect(url).toContain('period=day');
  });

  /* -- hashtag -- */
  it('searchHashtag returns hashtag ID', async () => {
    mockFetch({ data: [{ id: 'ht_123' }] });
    const id = await ig.searchHashtag('sunset', igConfig);
    expect(id).toBe('ht_123');
  });

  /* -- auth headers -- */
  it('uses Bearer token in auth headers', async () => {
    const spy = mockFetch({ data: [] });
    await ig.search({ query: '' }, igConfig);
    const headers = spy.mock.calls[0]![1].headers;
    expect(headers['Authorization']).toBe('Bearer ig-tok');
  });
});
