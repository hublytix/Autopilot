import { describe, expect, it } from 'vitest';
import { Button, Text } from 'react-email';
import { Layout } from '@/emails/Layout';
import { renderEmail } from './render';

describe('renderEmail', () => {
  it('renders the layout to HTML and plain text with the product name and the honest footer', async () => {
    const { html, text } = await renderEmail(
      <Layout productName="Hublytix Autopilot" preview="Your reply is ready">
        <Text>New lead: Asha</Text>
        <Button href="https://app.example/a/apt_x/send">Send from my email</Button>
      </Layout>,
    );
    expect(html).toMatch(/^<!DOCTYPE html/);
    expect(html).toContain('lang="en"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('max-width:560px');
    expect(html).toContain('Your reply is ready');
    expect(text).toContain('Hublytix Autopilot');
    expect(text).toContain('New lead: Asha');
    expect(text).toContain('Send from my email https://app.example/a/apt_x/send');
    expect(text).toContain('Hublytix Autopilot prepares drafts; it never sends email on your behalf.');
    expect(text).not.toContain('<');
  });

  it('uses the configured product name everywhere', async () => {
    const { text } = await renderEmail(
      <Layout productName="Acme Drafts">
        <Text>Hello</Text>
      </Layout>,
    );
    expect(text).toContain('Acme Drafts prepares drafts; it never sends email on your behalf.');
    expect(text).not.toContain('Hublytix');
  });

  it('escapes text content (templates receive plain strings)', async () => {
    const { html } = await renderEmail(
      <Layout productName="Hublytix Autopilot">
        <Text>{'<script>alert(1)</script>'}</Text>
      </Layout>,
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
