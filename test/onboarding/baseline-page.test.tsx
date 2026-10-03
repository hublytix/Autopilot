import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { useTestDb as setUpTestDb } from '../db/harness';
import { createOnboardingRig, selectForms, type OnboardingRig } from './support';

// /onboarding/baseline rendered over PGlite with the real read model (PLAN §7.5, §9.7, D-38). The
// baseline sends past submissions' message, first name, company and form name to the AI provider to
// sort out the leads, so the page says so where the owner starts it (law 5, D-49); /privacy says the
// same (test/pages/public-pages.test.tsx).

const current: { deps: Deps | null; scope: OwnerScope | null } = { deps: null, scope: null };

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect ${path}`);
  },
  notFound: () => {
    throw new Error('not found');
  },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('@/server/container', () => ({
  getDeps: async () => {
    if (current.deps === null) throw new Error('no deps');
    return current.deps;
  },
}));
vi.mock('@/server/http/auth/guards', () => ({
  requireOwnerPage: async () => {
    if (current.scope === null) throw new Error('redirect /login');
    return current.scope;
  },
}));

const getDb = setUpTestDb();
let rig: OnboardingRig;

beforeEach(async () => {
  rig = await createOnboardingRig(getDb());
  current.deps = rig.deps;
  current.scope = rig.scope;
});

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

async function baselinePage(): Promise<string> {
  const { default: Page } = await import('@/app/onboarding/baseline/page');
  const element: ReactElement = await Page({ searchParams: Promise.resolve({}) });
  return text(renderToStaticMarkup(element));
}

describe('/onboarding/baseline', () => {
  it('says that AI sorts the past submissions and that only the counts are kept (law 5)', async () => {
    await selectForms(rig);
    const page = await baselinePage();
    expect(page).toContain("We're reading the last 30 days of submissions on your forms");
    expect(page).toContain('AI sorts these submissions in memory to find the leads');
    expect(page).toContain('we keep only the counts and times below, nothing about the leads themselves.');
  });

  it('says the same before any form is chosen', async () => {
    const page = await baselinePage();
    expect(page).toContain('Choose your forms');
    expect(page).toContain('AI sorts these submissions in memory to find the leads');
  });
});
