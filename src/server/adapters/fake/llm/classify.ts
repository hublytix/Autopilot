import 'server-only';
import type { ClassifyInput, ClassifyOutput } from '@/server/ports/llm';

// The fake's deterministic keyword classifier (PLAN §4). Rules are checked in this order; the first
// match wins. A bare "job" is deliberately not a job-seeker marker: plumbing enquiries say "the job".

interface Rule {
  classification: ClassifyOutput['classification'];
  reason: string;
  patterns: readonly RegExp[];
}

export const FAKE_CLASSIFIER_RULES: readonly Rule[] = [
  {
    classification: 'spam',
    reason: 'spam_keyword',
    patterns: [
      /\bcrypto(?:currency|currencies)?\b/i,
      /\bbitcoin\b/i,
      /\bguest[- ]post(?:s|ing)?\b/i,
      /\bbacklinks?\b/i,
      /\bcasino\b/i,
      /\bforex\b/i,
      /\bclick here\b/i,
      /\bwork from home and earn\b/i,
    ],
  },
  {
    classification: 'vendor_pitch',
    reason: 'vendor_keyword',
    patterns: [
      /\bSEO\b/i,
      /\bsearch engine optimi[sz]ation\b/i,
      /\bweb(?:site)? (?:design|redesign|development) services?\b/i,
      /\blead generation\b/i,
      /\b(?:digital )?marketing (?:agency|services)\b/i,
      /\bfirst page of google\b/i,
      /\bapp development\b/i,
      /\boutsourc(?:e|ing)\b/i,
    ],
  },
  {
    classification: 'job_seeker',
    reason: 'job_keyword',
    patterns: [
      /\b(?:resume|cv)\b|\brésumé/i,
      /\b(?:looking for|seeking|apply(?:ing)? for|application for|interested in)\s+(?:a\s+|an\s+|the\s+)?(?:job|position|role|apprenticeship|work)\b/i,
      /\bjob (?:opening|vacanc(?:y|ies)|application|opportunit(?:y|ies))\b/i,
      /\b(?:are you|you are|you're) hiring\b/i,
    ],
  },
  {
    classification: 'support_request',
    reason: 'support_keyword',
    patterns: [
      /\binvoice\b/i,
      /\bmy order\b/i,
      /\border (?:number|no\.?|#)/i,
      /\breceipt\b/i,
      /\brefund\b/i,
      /\bexisting customer\b/i,
      /\bmy (?:account|bill)\b/i,
    ],
  },
];

export function classifyByKeywords(input: ClassifyInput): ClassifyOutput {
  const message = input.message?.trim() ?? '';
  if (message.length === 0) return { classification: 'unclear', reason_code: 'empty_message' };
  const text = [message, input.company ?? ''].join('\n');
  for (const rule of FAKE_CLASSIFIER_RULES) {
    if (rule.patterns.some((p) => p.test(text))) return { classification: rule.classification, reason_code: rule.reason };
  }
  return { classification: 'lead', reason_code: 'default_lead' };
}
