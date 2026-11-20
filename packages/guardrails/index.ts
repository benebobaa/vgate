export {
  DEFAULT_IGNORE,
  DEFAULT_RULE_TABLE_FILE,
  GUARDRAILS_FILE,
  RATCHET_FILE,
  loadGuardrails,
  parseGuardrails,
  type BannedPatternRule,
  type BoundaryRule,
  type CommentsConfig,
  type GuardrailsConfig,
  type NativeLinterRule,
  type RuleTableConfig,
} from './config.ts';

export {
  analyzeComments,
  detectLanguage,
  extractImports,
  stripComments,
  type CommentAnalysis,
  type CommentAnalysisOptions,
  type ExtractedImport,
  type Language,
} from './scanner.ts';

export {
  checkRuleTable,
  readRatchetBaseline,
  runGuardrails,
  writeRatchetBaseline,
  type GuardrailViolation,
  type LintReport,
  type NativeLinterResult,
  type RatchetBaseline,
  type RatchetTightening,
  type RuleTableResult,
  type RunGuardrailsOptions,
} from './engine.ts';

export { guardrailsConfigRule, ratchetBaselineRule, type GuardFinding, type GuardRuleOutcome } from './guard-rule.ts';

export {
  GUARDRAIL_PRESETS,
  PRESET_NAMES,
  expandPresets,
  testGuardrailFixtures,
  type FixtureTestCaseResult,
  type FixtureTestReport,
  type GuardrailPreset,
  type PresetName,
  type RuleFixture,
  type RuleFixtures,
} from './presets.ts';
