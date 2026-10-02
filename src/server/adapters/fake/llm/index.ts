import 'server-only';

export { FAKE_NEVER_PROMISE, briefFromPages } from './brief';
export { FAKE_CLASSIFIER_RULES, classifyByKeywords } from './classify';
export { MAX_SUBJECT_CHARS, flagsFor, followUpDraft, initialDraft, wordCount } from './drafts';
export { FAKE_LLM_DEFAULT_MODELS, FAKE_LLM_FAULTS, FAKE_LLM_PURPOSES, FakeLLM, fakeLlmMarker } from './fake-llm';
export type { FakeLlmCall, FakeLlmFault, FakeLlmFaultOptions, FakeLlmOptions, FakeLlmPurpose, FakeLlmRequest } from './fake-llm';
