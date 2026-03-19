#!/usr/bin/env node
/**
 * Debug helper: runs an MCP server's Docker container with stderr visible.
 * Reads .mcp.json, resolves env vars from process.env, and executes the docker command.
 *
 * IMPORTANT: Run this from a Claude Code session (via Bash tool).
 * Claude Code injects env vars from ~/.claude/settings.json into the process environment,
 * so MCP credentials are available without any file loading.
 *
 * Usage: node run-server.mjs <server-name>
 *
 * Zero dependencies — uses only Node builtins. Works after git clone with no install step.
 */

import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Project root is the directory containing this script
const projectRoot = __dirname;

/**
 * Expand ${VAR:-default} patterns using process.env.
 * Handles both ${VAR:-default} and ${VAR} (no default).
 */
function expandVar(val) {
  return String(val).replace(/\$\{([^:}]+)(?::-([^}]*))?\}/g, (_match, varName, defaultVal) => {
    return process.env[varName] ?? (defaultVal ?? '');
  });
}

function main() {
  const serverName = process.argv[2];

  if (!serverName) {
    console.error('Usage: node run-server.mjs <server-name>');
    console.error('Run from a Claude Code session so MCP credentials are in the environment.');
    process.exit(1);
  }

  // Read .mcp.json from project root
  const mcpPath = resolve(projectRoot, '.mcp.json');
  if (!existsSync(mcpPath)) {
    console.error(`Error: .mcp.json not found at ${mcpPath}`);
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
  } catch (err) {
    console.error(`Error: Failed to parse .mcp.json: ${err.message}`);
    process.exit(1);
  }

  const servers = config.mcpServers || {};
  const srv = servers[serverName];

  if (!srv) {
    const names = Object.keys(servers).join(', ');
    console.error(`Unknown server: ${serverName}`);
    console.error(`Available: ${names}`);
    process.exit(1);
  }

  if (srv.command !== 'docker') {
    console.error(`${serverName} does not use Docker (command: ${srv.command})`);
    process.exit(1);
  }

  // Resolve and set env vars from the server config
  const srvEnv = srv.env || {};
  for (const [key, value] of Object.entries(srvEnv)) {
    process.env[key] = expandVar(value);
  }

  // Build docker args, replacing -i with -it for interactive terminal
  const rawArgs = (srv.args || []).map((a) => expandVar(a));
  const dockerArgs = [];
  for (const arg of rawArgs) {
    if (arg === '-i') {
      dockerArgs.push('-it');
    } else {
      dockerArgs.push(arg);
    }
  }

  console.log(`Running: docker ${dockerArgs.join(' ')}`);
  console.log('---');

  const child = spawn('docker', dockerArgs, {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (err) => {
    console.error(`Failed to start docker: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code ?? 1);
  });
}

main();
