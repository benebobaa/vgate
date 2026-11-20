export { SURFACES, runCliSurface, runLibrarySurface } from './surfaces.ts';
export type {
  CliCheckSpec,
  LibrarySurfaceConfig,
  SurfaceCheckResult,
  SurfaceKind,
  SurfaceRunReport,
} from './surfaces.ts';

export { loadFeatureMap, maintainFeatureMap } from './feature-map.ts';
export type { FeatureDrift, FeatureEntry, FeatureMapLoadResult, MaintainReport } from './feature-map.ts';

export { checkSyncDrift, formalGuardRule, parseTlaStates, renderStatechart, runFormalChecks } from './formal.ts';
export type {
  FormalCheckResult,
  FormalEngine,
  FormalGuardFinding,
  FormalReport,
  FormalSpecConfig,
  StateTransition,
} from './formal.ts';

export { computeStats, evaluateBenchmark, runAlternatingBenchmark } from './benchmark.ts';
export type { BenchmarkChecklist, BenchmarkReport, BenchmarkStats, BenchmarkVerdict } from './benchmark.ts';

export {
  DEFAULT_TOLERATED_NOISE,
  canCarryVerdict,
  checkRebaseCeiling,
  computeSemanticPatchId,
  planContiguousLanding,
} from './patch-id.ts';
export type {
  ContiguousPlan,
  RebaseGuardResult,
  SemanticPatchIdResult,
  StackedPr,
  VerdictCarryDecision,
} from './patch-id.ts';

export { buildReviewBundle } from './artifacts.ts';
export type { ReviewArtifact, ReviewBundle } from './artifacts.ts';

export {
  DEFAULT_FLAKE_POLICY,
  QUARANTINE_FILE,
  evaluateFlakePolicy,
  loadQuarantine,
  parseQuarantine,
  quarantineGuardRule,
} from './flake.ts';
export type {
  FlakeEvaluation,
  FlakeOutcomeKind,
  FlakePolicy,
  FlakeTrial,
  QuarantineEntry,
  QuarantineGuardFinding,
} from './flake.ts';

export {
  canonicalJson,
  ciOidcClaims,
  signEvidence,
  verifyEvidenceSignature,
  writeSignedOrPlainJson,
} from './signing.ts';
export type {
  EvidenceSignature,
  OidcClaims,
  SignOptions,
  SignatureAlgorithm,
  SignedEnvelope,
  VerifySignatureOptions,
} from './signing.ts';
