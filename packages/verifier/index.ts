export {
  ROLES,
  canEscalate,
  inferFamily,
  parseRolesConfig,
  resolveAssignmentFamily,
  validateSeparationOfPowers,
  type RoleAssignment,
  type RoleName,
  type RolesConfig,
} from './roles.ts';

export {
  auditRoutines,
  checkBudget,
  type BudgetCheckResult,
  type BudgetLimits,
  type RoutineAuditResult,
  type RoutineRunRecord,
  type SpendSnapshot,
} from './budget.ts';

export {
  buildVerifierPrompt,
  judgeVerifierReport,
  parseVerifierOutput,
  runVerifierSwarm,
  selectVerifierMode,
  type SwarmAgentExecutor,
  type VerifierLaneResult,
  type VerifierMode,
  type VerifierReport,
  type VerifierVerdictKind,
} from './swarm.ts';

export {
  METRICS_FILE,
  appendKpiEvent,
  readKpiEvents,
  renderMetricsHtml,
  renderPrometheusMetrics,
  summarizeKpis,
  type KpiEvent,
  type KpiSummary,
} from './metrics.ts';
