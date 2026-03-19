/**
 * Command guardrails: pattern matching, arg processing, and output formatting.
 *
 * Extracted from server.js for testability. All functions are pure — they
 * depend only on their arguments, not on global state.
 */

import type { GuardrailConfig, CommandCheckResult, FormattedOutput } from './types.js';

/**
 * Convert a glob pattern (using * as wildcard) to a RegExp.
 * All regex-special characters except * are escaped.
 *
 * @example
 * globToRegex('ssm get-parameter*').test('ssm get-parameter --name /foo') // true
 * globToRegex('s3 *').test('s3 ls') // true
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
}

/**
 * Check a tokenized command against allowed/blocked patterns.
 *
 * Only checks the SUBCOMMAND tokens — tokens before the first flag (starting
 * with `-`). This prevents argument values from matching patterns. For example,
 * `["ssm", "get-parameter", "--name", "run-config"]` only checks `ssm` and
 * `get-parameter`, not `run-config` (which would falsely match `run-*`).
 *
 * Operates on the token array AFTER tokenization, so quoted words are already
 * unquoted. This prevents bypass via quoting blocked words.
 *
 * Patterns are matched against each subcommand token AND adjacent two-token pairs.
 * Blocked patterns take precedence over allowed patterns.
 * If no allowed patterns are configured, any non-blocked command is allowed.
 */
export function checkCommand(tokens: string[], config: GuardrailConfig): CommandCheckResult {
  // Extract only subcommand tokens (before the first flag starting with -)
  const subcommandTokens: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('-')) break;
    subcommandTokens.push(token);
  }

  // Build candidates: individual subcommand tokens + adjacent pairs
  const candidates = [...subcommandTokens];
  for (let i = 0; i < subcommandTokens.length - 1; i++) {
    candidates.push(`${subcommandTokens[i]} ${subcommandTokens[i + 1]}`);
  }

  // Check blocked patterns first (deny takes precedence)
  for (const pattern of config.blockedPatterns) {
    const regex = globToRegex(pattern);
    for (const candidate of candidates) {
      if (regex.test(candidate)) {
        return {
          allowed: false,
          reason: `Blocked: "${candidate}" matches blocked pattern "${pattern}"`,
        };
      }
    }
  }

  // If no allowed patterns specified, everything (not blocked) is allowed
  if (config.allowedPatterns.length === 0) {
    return { allowed: true };
  }

  // Check allowed patterns — at least one must match
  for (const pattern of config.allowedPatterns) {
    const regex = globToRegex(pattern);
    for (const candidate of candidates) {
      if (regex.test(candidate)) {
        return { allowed: true };
      }
    }
  }

  return {
    allowed: false,
    reason: `Not allowed: no token in command matches allowed patterns [${config.allowedPatterns.join(', ')}]`,
  };
}

/**
 * Process a tokenized command: strip forbidden args and prepend mandatory ones.
 *
 * Operates on the token array AFTER tokenization, so quoted variants of stripped
 * args (e.g., "--endpoint-url") are handled correctly — the tokenizer already
 * removed quotes before this runs.
 *
 * Strip args are removed along with their values (supports both --flag=value
 * and --flag value forms). Prepend args are added to the beginning.
 */
export function processTokens(tokens: string[], config: GuardrailConfig): string[] {
  let result = [...tokens];

  for (const arg of config.stripArgs) {
    const filtered: string[] = [];
    let i = 0;
    while (i < result.length) {
      const token = result[i];

      // --flag=value form (e.g., --profile=dev)
      if (token.startsWith(arg + '=')) {
        i++;
        continue;
      }

      // Exact match (e.g., --profile)
      if (token === arg) {
        i++;
        // Consume the following value if it's not another flag
        if (i < result.length && !result[i].startsWith('-')) {
          i++;
        }
        continue;
      }

      // No match — keep the token
      filtered.push(token);
      i++;
    }
    result = filtered;
  }

  // Prepend mandatory args
  if (config.prependArgs.length > 0) {
    result = [...config.prependArgs, ...result];
  }

  return result;
}

/**
 * Format CLI output, auto-detecting JSON responses.
 *
 * If stdout looks like JSON (starts with { or [) and parses successfully,
 * returns a structured JSON result. Otherwise returns plain text.
 */
export function formatOutput(stdout: string, stderr: string): FormattedOutput {
  const trimmed = stdout.trim();

  // Try JSON parsing
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return {
        type: 'json',
        data: parsed,
        ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
      };
    } catch {
      // Not valid JSON, fall through
    }
  }

  return {
    type: 'text',
    output: trimmed,
    ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
  };
}
