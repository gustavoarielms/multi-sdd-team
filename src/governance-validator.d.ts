export interface GovernanceValidationOptions {
  expectedAgent?: string;
}

export interface GovernanceValidationSuccess {
  ok: true;
  value: Record<string, any>;
  errors: [];
}

export interface GovernanceValidationFailure {
  ok: false;
  errors: string[];
}

export function normalizeAgentName(name: unknown): string;
export function isStructuredReviewAgent(name: unknown): boolean;
export function validateGovernanceDocument(
  schemaName: string,
  value: unknown,
): Promise<{ valid: boolean; errors: string[] }>;
export function validateAgentResult(
  value: unknown,
  options?: GovernanceValidationOptions,
): Promise<GovernanceValidationSuccess | GovernanceValidationFailure>;
export function validateAgentResultText(
  text: unknown,
  options?: GovernanceValidationOptions,
): Promise<GovernanceValidationSuccess | GovernanceValidationFailure>;
export function validateGovernanceCatalog(
  catalog: unknown,
  registry: unknown,
  engineeringGateRegistry?: unknown,
  engineeringQualityProfile?: unknown,
): Promise<GovernanceValidationSuccess | GovernanceValidationFailure>;
export function validateGovernanceCheckResult(
  value: unknown,
): Promise<GovernanceValidationSuccess | GovernanceValidationFailure>;
export function validateEngineeringGateConfiguration(
  value: unknown,
): Promise<{ valid: boolean; errors: string[] }>;
export function validateEngineeringGateRun(
  value: unknown,
): Promise<GovernanceValidationSuccess | GovernanceValidationFailure>;
export function validateEngineeringQualityProfile(
  value: unknown,
  catalogValue?: unknown,
): Promise<GovernanceValidationSuccess | GovernanceValidationFailure>;
export function engineeringExecutorIds(): string[];
