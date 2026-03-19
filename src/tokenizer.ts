/**
 * Command tokenizer with shell metacharacter rejection.
 *
 * SECURITY-CRITICAL: This module prevents shell injection by rejecting commands
 * that contain shell metacharacters (outside of quoted strings) and splitting
 * command strings into argument arrays for use with execFile().
 *
 * The tokenizer is intentionally strict — it rejects anything that looks like
 * shell syntax rather than trying to interpret it. This is the safe default
 * for a system that passes commands to execFile().
 */

/**
 * Shell metacharacters that indicate injection attempts.
 * Each entry is [pattern, description] where pattern is a string or regex
 * to match against unquoted portions of the command.
 */
const SHELL_METACHARACTERS: Array<[string, string]> = [
  [';', "';'"],
  ['|', "'|'"],
  ['&', "'&'"],
  ['$(', "'$('"],
  ['`', "'`'"],
  ['>', "'>'"],
  ['<', "'<'"],
  ['${', "'${'"],
];

const NEWLINE_PATTERN = /[\n\r]/;

/**
 * Scan a command string for shell metacharacters that appear outside quoted regions.
 * Throws an Error if any are found.
 *
 * Strategy: walk the string character by character, tracking whether we're inside
 * a single-quoted or double-quoted region. Only check for metacharacters in
 * unquoted regions.
 */
function rejectShellMetacharacters(command: string): void {
  // Newlines are always rejected regardless of quoting — they can break
  // argument boundaries in ways that are hard to reason about safely.
  if (NEWLINE_PATTERN.test(command)) {
    throw new Error(
      'Shell metacharacter rejected: found newline — command injection is not allowed'
    );
  }

  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // Track quote state transitions
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    // Inside double quotes, backslash escapes the next character
    if (inDoubleQuote && ch === '\\' && i + 1 < command.length) {
      i++; // skip the escaped character
      continue;
    }

    // Only check metacharacters in unquoted regions
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    // Check each metacharacter pattern against the current position
    for (const [pattern, display] of SHELL_METACHARACTERS) {
      if (command.startsWith(pattern, i)) {
        throw new Error(
          `Shell metacharacter rejected: found ${display} — command injection is not allowed`
        );
      }
    }
  }

  // Unterminated quotes are suspicious — reject them
  if (inSingleQuote) {
    throw new Error('Unterminated single quote in command');
  }
  if (inDoubleQuote) {
    throw new Error('Unterminated double quote in command');
  }
}

/**
 * Tokenize a command string into an argument array.
 *
 * Splits on whitespace, respecting single and double quotes.
 * Inside double quotes, backslash escapes the next character.
 * In unquoted context, backslash is treated as a literal character
 * (Windows path separator compatibility).
 *
 * @param command - The command string (everything after the CLI tool name)
 * @returns Array of string tokens
 * @throws Error if shell metacharacters are detected outside quotes
 * @throws Error if quotes are unterminated
 *
 * @example
 * tokenizeCommand('ssm get-parameter --name /foo')
 * // => ['ssm', 'get-parameter', '--name', '/foo']
 *
 * tokenizeCommand('--filter "Name=tag:env"')
 * // => ['--filter', 'Name=tag:env']
 *
 * tokenizeCommand('--config C:\\Users\\foo')
 * // => ['--config', 'C:\\Users\\foo']
 */
export function tokenizeCommand(command: string): string[] {
  // Step 1: Reject shell metacharacters (before any tokenization)
  rejectShellMetacharacters(command);

  // Step 2: Tokenize the (now validated) command string
  const tokens: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // Handle quote transitions
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    // Inside double quotes, backslash escapes the next character
    if (inDoubleQuote && ch === '\\' && i + 1 < command.length) {
      i++;
      current += command[i];
      continue;
    }

    // Whitespace outside quotes: finalize current token
    if (!inSingleQuote && !inDoubleQuote && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    // Everything else (including unquoted backslash) is literal
    current += ch;
  }

  // Push the last token if present
  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}
