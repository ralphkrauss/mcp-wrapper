/**
 * Shared type definitions for the CLI-to-MCP server.
 */

/** Configuration for command guardrails (allow/block patterns, arg manipulation). */
export interface GuardrailConfig {
  allowedPatterns: string[];
  blockedPatterns: string[];
  prependArgs: string[];
  stripArgs: string[];
}

/** Result of checking a command against guardrail patterns. */
export interface CommandCheckResult {
  allowed: boolean;
  reason?: string;
}

/** Structured output from a CLI command execution. */
export interface FormattedOutput {
  type: 'json' | 'text';
  data?: unknown;
  output?: string;
  stderr?: string;
}
