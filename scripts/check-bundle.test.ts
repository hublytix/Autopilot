import { FAKE_HUBSPOT_PRIVATE_APP_TOKEN, FAKE_HUBSPOT_REFRESH_TOKEN, QSTASH_PUBLIC_DEV_TOKEN } from '../test/support/fake-secrets';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_ENV } from '@/server/env';
import { checkBundle, DEFAULT_TARGETS } from './check-bundle';

// The client-bundle secret check (PLAN §10.13) on a planted build directory: it must look at the
// prerendered HTML/RSC payloads as well as the static assets, and at .env-file values.

let cwd: string;
let savedEnv: NodeJS.ProcessEnv;

async function put(relativePath: string, text: string): Promise<void> {
  const file = path.join(cwd, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

/** A clean build: one asset, one prerendered page, and a server bundle that names env vars (allowed). */
async function cleanBuild(): Promise<void> {
  await put('.next/static/chunks/main.js', 'console.log("hello");');
  await put('.next/server/app/index.html', '<!doctype html><p>Hublytix Autopilot</p>');
  await put('.next/server/app/index.rsc', '0:{"title":"Hublytix Autopilot"}');
  await put('.next/server/app/page.js', 'const url = process.env.DATABASE_URL; const s = process.env.APP_SECRET;');
}

beforeEach(async () => {
  savedEnv = { ...process.env };
  cwd = await mkdtemp(path.join(tmpdir(), 'autopilot-bundle-'));
  await cleanBuild();
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(cwd, { recursive: true, force: true });
});

const labels = (result: Awaited<ReturnType<typeof checkBundle>>): string[] => result.hits.map((hit) => `${hit.file}: ${hit.label}`);

describe('check:bundle', () => {
  it('passes a clean build, and does not scan the server-only bundles', async () => {
    const result = await checkBundle(DEFAULT_TARGETS, cwd);
    expect(result.problems).toEqual([]);
    expect(result.hits).toEqual([]);
    expect(result.files).toBe(3);
  });

  it('finds a fake secret planted in a prerendered RSC payload', async () => {
    await put('.next/server/app/login.rsc', `1:{"config":{"secret":"${FAKE_ENV.RAZORPAY_KEY_SECRET}"}}`);
    expect(labels(await checkBundle(DEFAULT_TARGETS, cwd))).toEqual(
      expect.arrayContaining([
        `${path.join('.next', 'server', 'app', 'login.rsc')}: fake secret marker (fake-only)`,
        `${path.join('.next', 'server', 'app', 'login.rsc')}: fake value of RAZORPAY_KEY_SECRET`,
      ]),
    );
  });

  it('finds a server-only env name in prerendered HTML, a segment payload and a route body', async () => {
    await put('.next/server/app/index.html', '<p>APP_SECRET</p>');
    await put('.next/server/app/index.segments/__PAGE__.segment.rsc', '0:["DATABASE_URL"]');
    await put('.next/server/app/api/x.body', '{"mode":"CRON_SECRET"}');
    const found = labels(await checkBundle(DEFAULT_TARGETS, cwd));
    expect(found).toContain(`${path.join('.next', 'server', 'app', 'index.html')}: server-only env var name APP_SECRET`);
    expect(found).toContain(`${path.join('.next', 'server', 'app', 'index.segments', '__PAGE__.segment.rsc')}: server-only env var name DATABASE_URL`);
    expect(found).toContain(`${path.join('.next', 'server', 'app', 'api', 'x.body')}: server-only env var name CRON_SECRET`);
  });

  it('finds the value of a secret set only in .env.local (a 24-character Razorpay key secret has no shape to match)', async () => {
    const value = 'Xq7Lm2Np9Rs4Tv8Wy3Za6Bc1';
    await put('.env.local', `RAZORPAY_KEY_SECRET=${value}\n`);
    await put('.next/server/pages/500.html', `<script>window.k="${value}"</script>`);
    expect(labels(await checkBundle(DEFAULT_TARGETS, cwd))).toEqual([
      `${path.join('.next', 'server', 'pages', '500.html')}: value of RAZORPAY_KEY_SECRET from .env.local`,
    ]);
    expect(process.env.RAZORPAY_KEY_SECRET).toBeUndefined();
  });

  it('finds the value of a secret set in the current environment', async () => {
    const value = 'Pq3Rs8Tu1Vw6Xy9Za2Bc5De7';
    process.env.RAZORPAY_WEBHOOK_SECRET = value;
    await put('.next/static/chunks/leak.js', `var w="${value}";`);
    expect(labels(await checkBundle(DEFAULT_TARGETS, cwd))).toEqual([
      `${path.join('.next', 'static', 'chunks', 'leak.js')}: value of RAZORPAY_WEBHOOK_SECRET from the current environment`,
    ]);
  });

  it.each([
    ['a HubSpot refresh token', FAKE_HUBSPOT_REFRESH_TOKEN, 'HubSpot token (na1-… / pat-na1-…)'],
    ['a HubSpot private-app token', FAKE_HUBSPOT_PRIVATE_APP_TOKEN, 'HubSpot token (na1-… / pat-na1-…)'],
    ['the QStash dev token', QSTASH_PUBLIC_DEV_TOKEN, 'base64 JSON token (eyJ…)'],
  ])('finds %s in a static asset', async (_name, secret, label) => {
    await put('.next/static/chunks/leak.js', `var t="${secret}";`);
    expect(labels(await checkBundle(DEFAULT_TARGETS, cwd))).toContain(`${path.join('.next', 'static', 'chunks', 'leak.js')}: ${label}`);
  });

  it('fails when a required directory is missing or holds nothing to scan', async () => {
    await rm(path.join(cwd, '.next', 'server'), { recursive: true });
    expect((await checkBundle(DEFAULT_TARGETS, cwd)).problems).toEqual([
      `${path.join('.next', 'server', 'app')} not found. Build first: APP_MODE=fake npm run build`,
    ]);
    await put('.next/server/app/page.js', '');
    expect((await checkBundle(DEFAULT_TARGETS, cwd)).problems).toEqual([
      `no client-delivered files under ${path.join('.next', 'server', 'app')}; the build output looks incomplete.`,
    ]);
  });
});
