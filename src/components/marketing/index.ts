// The public pages' building blocks (landing and legal pages): client-safe, no server imports.
export {
  BASELINE_HEADING,
  BASELINE_NOTE,
  DATA_SOURCE,
  EMAIL_METADATA_NOTE,
  HUBSPOT_DISCLOSURE,
  INSTALL_PERMISSION_NOTE,
  LEGAL_LINKS,
  LEGAL_TODO,
  PRICE_LINE,
  SUB_PROCESSORS,
} from './legal';
export type { LegalLink, SubProcessor } from './legal';
export { LegalPage, LegalSection } from './LegalPage';
export type { LegalPageProps, LegalSectionProps } from './LegalPage';
export { SiteFooter } from './SiteFooter';
export type { SiteFooterProps } from './SiteFooter';
