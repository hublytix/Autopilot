import 'server-only';

// The billing route handlers (PLAN §7.3): POST /api/billing/{checkout,resume,cancel}. Route files
// stay thin: they import from here. The billing pages' read models are in server/views/billing.
export { handleBillingControl, handleBillingControlOtherMethod } from './control';
