import { describe, expect, it } from 'vitest';
import { renderPortalEmail } from './email-layout';

describe('renderPortalEmail', () => {
  it('builds a black-and-white HTML card with a CTA', () => {
    const { html, text } = renderPortalEmail({
      eyebrow: 'Profile',
      title: 'Your profile was updated',
      greeting: 'Hi Sandip,',
      paragraphs: ['An administrator updated your HR Portal profile.'],
      cta: { label: 'Sign in', href: 'http://localhost:3000/login' },
    });

    expect(html).toContain('HR PORTAL');
    expect(html).toContain('#111111');
    expect(html).toContain('#ffffff');
    expect(html).toContain('Sign in');
    expect(html).toContain('http://localhost:3000/login');
    expect(html).not.toContain('<script');
    expect(text).toContain('Hi Sandip,');
    expect(text).toContain('http://localhost:3000/login');
  });

  it('escapes values from the product', () => {
    const { html } = renderPortalEmail({
      title: 'Leave <pending>',
      paragraphs: ['Name: <b>x</b>'],
      details: [{ label: 'Email', value: 'a@b.com' }],
    });
    expect(html).toContain('Leave &lt;pending&gt;');
    expect(html).toContain('Name: &lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('a@b.com');
  });
});
