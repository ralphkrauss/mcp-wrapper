/**
 * Generic CLI-to-MCP wrapper server.
 *
 * Wraps any CLI tool (aws, gh, etc.) as an MCP server with guardrails.
 * Runs in Docker for OS-agnostic operation. Configuration entirely via env vars.
 *
 * Security: Uses execFile() instead of exec() to avoid shell interpretation.
 * Commands are tokenized and validated before execution — shell metacharacters
 * are rejected at the tokenizer level.
 *
 * Usage: node server.js <cli-tool-name>
 * Example: node server.js aws
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { GuardrailConfig } from './types.js';
import { tokenizeCommand } from './tokenizer.js';
import { checkCommand, processTokens, formatOutput } from './guardrails.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const cliTool = process.argv[2];
if (!cliTool) {
  process.stderr.write('Usage: node server.js <cli-tool-name>\n');
  process.exit(1);
}

const requiredEnv: string[] = (process.env.MCP_REQUIRED_ENV || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const allowedPatterns: string[] = (process.env.MCP_ALLOWED_PATTERNS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const blockedPatterns: string[] = (process.env.MCP_BLOCKED_PATTERNS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const prependArgs: string[] = JSON.parse(process.env.MCP_PREPEND_ARGS || '[]') as string[];
const stripArgs: string[] = JSON.parse(process.env.MCP_STRIP_ARGS || '[]') as string[];
const description: string = process.env.MCP_DESCRIPTION || `${cliTool} CLI`;
const examples: string[] = JSON.parse(process.env.MCP_EXAMPLES || '[]') as string[];
const timeoutMs: number = parseInt(process.env.MCP_TIMEOUT_MS || '30000', 10);

const guardrailConfig: GuardrailConfig = {
  allowedPatterns,
  blockedPatterns,
  prependArgs,
  stripArgs,
};

// ---------------------------------------------------------------------------
// Credential-driven activation: exit if required env vars are missing
// ---------------------------------------------------------------------------

for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    process.stderr.write(
      `cli-mcp [${cliTool}]: skipping — ${envVar} not set\n`
    );
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Internal log buffer (ring buffer of last 50 entries)
// ---------------------------------------------------------------------------

const logBuffer: string[] = [];
const LOG_MAX = 50;

function log(message: string): void {
  const entry = `[${new Date().toISOString()}] ${message}`;
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  process.stderr.write(entry + '\n');
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: `cli-mcp-${cliTool}`, version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'execute',
      description: `Run a ${cliTool} CLI command. The command is everything after "${cliTool}" — e.g., for "aws ssm get-parameter --name /foo", pass "ssm get-parameter --name /foo".`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          command: {
            type: 'string',
            description: `The ${cliTool} command to execute (without the "${cliTool}" prefix)`,
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'help',
      description: `Show available commands, examples, and current restrictions for this ${cliTool} instance.`,
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'diagnose',
      description: `Troubleshoot this ${cliTool} MCP server. Shows CLI version, environment variables (names only), guardrail config, and recent log entries.`,
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}));

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'help') {
    const lines: string[] = [description, `CLI tool: ${cliTool}`, ''];

    if (allowedPatterns.length > 0) {
      lines.push(`Allowed operations: ${allowedPatterns.join(', ')}`);
    } else {
      lines.push('Allowed operations: all (no restrictions)');
    }

    if (blockedPatterns.length > 0) {
      lines.push(`Blocked operations: ${blockedPatterns.join(', ')}`);
    }

    if (stripArgs.length > 0) {
      lines.push(`Stripped args (enforced by server): ${stripArgs.join(', ')}`);
    }

    if (prependArgs.length > 0) {
      lines.push(`Auto-injected args: ${prependArgs.join(' ')}`);
    }

    if (examples.length > 0) {
      lines.push('', 'Examples:');
      for (const example of examples) {
        lines.push(`  ${cliTool} ${example}`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (name === 'diagnose') {
    const lines: string[] = [`Diagnostics for ${cliTool} MCP server`, ''];

    // CLI version
    try {
      const { stdout } = await execFileAsync(cliTool, ['--version'], {
        timeout: 5000,
        env: process.env,
      });
      lines.push(`CLI version: ${stdout.trim()}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`CLI version: FAILED — ${message}`);
    }

    // Environment variables (names only, not values — security)
    lines.push('', 'Environment variables set:');
    const relevantPrefixes = ['AWS_', 'GH_', 'GITHUB_', 'TF_', 'MCP_'];
    for (const [key, value] of Object.entries(process.env)) {
      if (relevantPrefixes.some((p) => key.startsWith(p))) {
        lines.push(`  ${key} = ${value ? '(set)' : '(empty)'}`);
      }
    }

    // Working directory and filesystem
    lines.push('', `Working directory: ${process.cwd()}`);
    try {
      const { stdout } = await execFileAsync('ls', ['-la'], {
        timeout: 3000,
      });
      lines.push(`Directory listing:\n${stdout.trim()}`);
    } catch {
      lines.push('Directory listing: failed');
    }

    // Guardrail config
    lines.push('', 'Guardrails:');
    lines.push(`  Allowed patterns: ${allowedPatterns.length > 0 ? allowedPatterns.join(', ') : '(all)'}`);
    lines.push(`  Blocked patterns: ${blockedPatterns.length > 0 ? blockedPatterns.join(', ') : '(none)'}`);
    lines.push(`  Strip args: ${stripArgs.length > 0 ? stripArgs.join(', ') : '(none)'}`);
    lines.push(`  Prepend args: ${prependArgs.length > 0 ? prependArgs.join(' ') : '(none)'}`);

    // Recent logs
    if (logBuffer.length > 0) {
      lines.push('', `Recent logs (last ${logBuffer.length}):`);
      for (const entry of logBuffer) {
        lines.push(`  ${entry}`);
      }
    } else {
      lines.push('', 'Recent logs: (none)');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (name === 'execute') {
    const command = (args as Record<string, unknown> | undefined)?.command;
    if (!command || typeof command !== 'string') {
      return {
        content: [{ type: 'text', text: 'Error: command parameter is required' }],
        isError: true,
      };
    }

    // Tokenize the command into an argument array FIRST.
    // tokenizeCommand() throws on shell metacharacters — this is the
    // security boundary that prevents injection via execFile().
    let tokens: string[];
    try {
      tokens = tokenizeCommand(command);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log(`rejected: ${message}`);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }

    // Check guardrails AFTER tokenization so quotes are already stripped.
    // This prevents bypass via quoting blocked words (e.g., "repo" "delete").
    const check = checkCommand(tokens, guardrailConfig);
    if (!check.allowed) {
      return {
        content: [{ type: 'text', text: `Error: ${check.reason}` }],
        isError: true,
      };
    }

    // Process tokens: strip forbidden args, prepend mandatory ones.
    // Also runs after tokenization so quoted arg names are correctly matched.
    tokens = processTokens(tokens, guardrailConfig);

    log(`execute: ${cliTool} ${tokens.join(' ')}`);

    try {
      const { stdout, stderr } = await execFileAsync(cliTool, tokens, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: process.env,
      });

      const result = formatOutput(stdout, stderr);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error: unknown) {
      const execError = error as { stderr?: string; stdout?: string; code?: number; message?: string };
      const output = execError.stderr || execError.stdout || execError.message || 'Unknown error';
      log(`error: exit ${execError.code ?? 'unknown'} — ${output.substring(0, 200)}`);
      return {
        content: [{ type: 'text', text: `Error (exit code ${execError.code ?? 'unknown'}):\n${output}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// Graceful shutdown
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
log(`connected (${description})`);
