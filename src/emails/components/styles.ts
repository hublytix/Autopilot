import type { CSSProperties } from 'react';

// Shared inline styles for the lead emails (new lead, needs touch, follow-up, reply detected). Email
// clients ignore stylesheets, so every part carries its own inline style. Mobile-first: one fluid
// column, 16 px body text (react-email's Text defaults to 14 px, so it is set here), buttons at
// least 44 px tall, high-contrast colours.

const bodyText = { fontSize: '16px', lineHeight: '24px' } as const;

export const notice: CSSProperties = { margin: '0 0 16px', fontSize: '14px', lineHeight: '20px', color: '#52525b' };
export const heading: CSSProperties = { margin: '0 0 16px', fontSize: '22px', lineHeight: '28px', fontWeight: 600 };
export const subheading: CSSProperties = { margin: '24px 0 8px', fontSize: '16px', lineHeight: '24px', fontWeight: 600 };
export const paragraph: CSSProperties = { ...bodyText, margin: '0 0 12px' };
export const cardLine: CSSProperties = { ...bodyText, margin: '0 0 4px' };
export const cardLabel: CSSProperties = { color: '#52525b' };
export const quote: CSSProperties = {
  ...bodyText,
  margin: '0 0 16px',
  padding: '8px 12px',
  borderLeft: '3px solid #d4d4d8',
  color: '#3f3f46',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
export const draftBox: CSSProperties = {
  margin: '0 0 16px',
  padding: '12px',
  border: '1px solid #e4e4e7',
  borderRadius: '6px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
export const draftSubject: CSSProperties = { ...bodyText, margin: '0 0 8px', fontWeight: 600 };
export const draftBody: CSSProperties = { ...bodyText, margin: 0 };
export const primaryButton: CSSProperties = {
  display: 'inline-block',
  margin: '0 8px 8px 0',
  padding: '12px 20px',
  borderRadius: '6px',
  backgroundColor: '#18181b',
  color: '#ffffff',
  fontSize: '16px',
  lineHeight: '20px',
  fontWeight: 600,
  textDecoration: 'none',
};
export const secondaryButton: CSSProperties = {
  ...primaryButton,
  backgroundColor: '#ffffff',
  color: '#18181b',
  border: '1px solid #a1a1aa',
};
export const note: CSSProperties = { margin: '16px 0 0', fontSize: '14px', lineHeight: '20px', color: '#52525b' };
export const honestNote: CSSProperties = {
  margin: '0 0 12px',
  padding: '8px 12px',
  borderRadius: '6px',
  backgroundColor: '#fef9c3',
  color: '#422006',
  fontSize: '14px',
  lineHeight: '20px',
};
export const link: CSSProperties = { color: '#1d4ed8', textDecoration: 'underline' };
