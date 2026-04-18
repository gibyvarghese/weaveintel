const baseUrl = process.env.BASE_URL ?? 'http://localhost:3500';

async function call(path, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, setCookie };
}

function extractGwCookie(setCookie) {
  const m = setCookie.match(/gw_token=([^;]+)/);
  return m ? `gw_token=${m[1]}` : '';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const email = `smoke-${Date.now()}@weaveintel.dev`;
  const password = 'Str0ng!Pass99';

  const register = await call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Smoke User', email, password },
  });
  assert(register.status === 201, `register failed (${register.status})`);

  const cookie = extractGwCookie(register.setCookie);
  const csrf = register.data.csrfToken;
  assert(Boolean(cookie), 'missing auth cookie after register');
  assert(typeof csrf === 'string' && csrf.length > 0, 'missing csrf token after register');

  const me = await call('/api/auth/me', { cookie });
  assert(me.status === 200, `/api/auth/me failed (${me.status})`);

  const prompts = await call('/api/admin/prompts', { cookie });
  assert(prompts.status === 200, `/api/admin/prompts list failed (${prompts.status})`);

  const badPrompt = await call('/api/admin/prompts', {
    method: 'POST',
    cookie,
    csrf,
    body: {
      name: 'TooShortPrompt',
      description: 'short desc',
      template: 'Hello {{name}}',
      variables: [{ name: 'name', type: 'string', required: true }],
      version: '1.0',
      enabled: true,
    },
  });
  assert(badPrompt.status === 400, `expected 400 for short prompt description, got ${badPrompt.status}`);

  const goodPrompt = await call('/api/admin/prompts', {
    method: 'POST',
    cookie,
    csrf,
    body: {
      name: 'Smoke Prompt Runtime',
      description: 'Render a deterministic smoke-test prompt that demonstrates model-facing intent and expected variable usage.',
      template: 'Hello {{name}}, this is a smoke check.',
      variables: [{ name: 'name', type: 'string', required: true }],
      version: '1.0',
      enabled: true,
      prompt_type: 'template',
      status: 'published',
      category: 'smoke-test',
    },
  });
  assert(goodPrompt.status === 201, `prompt create failed (${goodPrompt.status})`);
  const promptId = goodPrompt.data?.prompt?.id;
  assert(typeof promptId === 'string' && promptId.length > 0, 'missing created prompt id');

  const preview = await call('/api/prompts/resolve', {
    method: 'POST',
    cookie,
    csrf,
    body: { promptId, variables: { name: 'Verifier' } },
  });
  assert(preview.status === 200, `prompt preview failed (${preview.status})`);
  assert(typeof preview.data.rendered === 'string' && preview.data.rendered.includes('Verifier'), 'preview output missing rendered variable');

  const badSkill = await call('/api/admin/skills', {
    method: 'POST',
    cookie,
    csrf,
    body: {
      name: 'Bad Skill',
      description: 'too short',
      instructions: 'Do the thing',
      category: 'general',
      enabled: true,
    },
  });
  assert(badSkill.status === 400, `expected 400 for short skill description, got ${badSkill.status}`);

  const goodTool = await call('/api/admin/tools', {
    method: 'POST',
    cookie,
    csrf,
    body: {
      name: 'Smoke Tool Config',
      description: 'Configuration metadata for a synthetic smoke-test tool used to validate model-facing discovery behavior.',
      category: 'smoke-test',
      risk_level: 'low',
      enabled: true,
    },
  });
  assert(goodTool.status === 201, `tool create failed (${goodTool.status})`);

  console.log('API smoke checks passed:', {
    baseUrl,
    user: me.data.user?.email,
    promptId,
    rendered: preview.data.rendered,
  });
}

run().catch((err) => {
  console.error('API smoke failed:', err.message);
  process.exit(1);
});
