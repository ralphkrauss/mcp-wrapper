import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegex, checkCommand, processTokens, formatOutput } from '../guardrails.js';
import type { GuardrailConfig } from '../types.js';

/** Helper to build a GuardrailConfig with sensible defaults. */
function config(overrides: Partial<GuardrailConfig> = {}): GuardrailConfig {
  return {
    allowedPatterns: [],
    blockedPatterns: [],
    prependArgs: [],
    stripArgs: [],
    ...overrides,
  };
}

describe('globToRegex', () => {
  it('matches trailing wildcard', () => {
    const regex = globToRegex('get-*');
    assert.ok(regex.test('get-parameter'));
    assert.ok(regex.test('get-item'));
    assert.ok(!regex.test('delete-item'));
    assert.ok(!regex.test('put-parameter'));
  });

  it('matches full wildcard', () => {
    const regex = globToRegex('*');
    assert.ok(regex.test('anything'));
    assert.ok(regex.test(''));
    assert.ok(regex.test('multi word'));
  });

  it('matches exact string with no wildcard', () => {
    const regex = globToRegex('exact');
    assert.ok(regex.test('exact'));
    assert.ok(!regex.test('exactlyNot'));
    assert.ok(!regex.test('not-exact'));
    assert.ok(!regex.test(''));
  });

  it('matches multiple wildcards', () => {
    const regex = globToRegex('get-*-by-*');
    assert.ok(regex.test('get-item-by-id'));
    assert.ok(regex.test('get-user-by-email'));
    assert.ok(!regex.test('delete-item-by-id'));
  });

  it('escapes regex-special characters (dot)', () => {
    const regex = globToRegex('foo.bar');
    assert.ok(regex.test('foo.bar'));
    assert.ok(!regex.test('fooXbar'));
    assert.ok(!regex.test('foo-bar'));
  });

  it('escapes regex-special characters (square brackets)', () => {
    const regex = globToRegex('item[0]');
    assert.ok(regex.test('item[0]'));
    assert.ok(!regex.test('item0'));
  });

  it('escapes regex-special characters (parentheses)', () => {
    const regex = globToRegex('func(x)');
    assert.ok(regex.test('func(x)'));
    assert.ok(!regex.test('funcx'));
  });

  it('escapes plus sign', () => {
    const regex = globToRegex('a+b');
    assert.ok(regex.test('a+b'));
    assert.ok(!regex.test('aab'));
    assert.ok(!regex.test('ab'));
  });

  it('escapes question mark as literal', () => {
    const regex = globToRegex('item?');
    assert.ok(regex.test('item?'));
    assert.ok(!regex.test('item'));
    assert.ok(!regex.test('itemX'));
  });

  it('anchors match to full string', () => {
    const regex = globToRegex('get');
    assert.ok(!regex.test('get-parameter'));
    assert.ok(!regex.test('forget'));
    assert.ok(regex.test('get'));
  });

  it('combines escaping with wildcards', () => {
    const regex = globToRegex('s3.*');
    assert.ok(regex.test('s3.bucket'));
    assert.ok(regex.test('s3.anything'));
    assert.ok(!regex.test('s3Xbucket'));
  });
});

describe('checkCommand', () => {
  it('blocks command matching a blocked pattern', () => {
    const result = checkCommand(
      ['s3api', 'delete-object', '--bucket', 'x'],
      config({ blockedPatterns: ['delete-*'] })
    );
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason?.includes('delete-'));
  });

  it('allows command matching an allowed pattern', () => {
    const result = checkCommand(
      ['ssm', 'get-parameter', '--name', '/foo'],
      config({ allowedPatterns: ['get-*'] })
    );
    assert.strictEqual(result.allowed, true);
  });

  it('blocks command not matching any allowed pattern', () => {
    const result = checkCommand(
      ['ssm', 'put-parameter', '--name', '/foo'],
      config({ allowedPatterns: ['get-*'] })
    );
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason?.includes('Not allowed'));
    assert.ok(result.reason?.includes('get-*'));
  });

  it('blocked takes precedence over allowed', () => {
    const result = checkCommand(
      ['delete-bucket'],
      config({ allowedPatterns: ['*'], blockedPatterns: ['delete-*'] })
    );
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason?.includes('Blocked'));
  });

  it('allows anything when no patterns are configured', () => {
    const result = checkCommand(
      ['any-command', '--with', 'args'],
      config({ allowedPatterns: [], blockedPatterns: [] })
    );
    assert.strictEqual(result.allowed, true);
  });

  it('matches two-token pairs for blocking', () => {
    const result = checkCommand(
      ['repo', 'delete', 'my-repo'],
      config({ blockedPatterns: ['repo delete'] })
    );
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason?.includes('repo delete'));
  });

  it('matches two-token pairs for allowing', () => {
    const result = checkCommand(
      ['ssm', 'get-parameter', '--name', '/foo'],
      config({ allowedPatterns: ['ssm get-parameter'] })
    );
    assert.strictEqual(result.allowed, true);
  });

  it('reason includes the matching blocked pattern name', () => {
    const result = checkCommand(
      ['rm', '-rf', '/'],
      config({ blockedPatterns: ['rm'] })
    );
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason?.includes('"rm"'));
    assert.ok(result.reason?.includes('blocked pattern'));
  });

  it('allows command when blocked pattern does not match', () => {
    const result = checkCommand(
      ['ssm', 'get-parameter'],
      config({ blockedPatterns: ['delete-*'] })
    );
    assert.strictEqual(result.allowed, true);
  });

  it('handles multiple blocked patterns', () => {
    const cfg = config({ blockedPatterns: ['delete-*', 'rm', 'drop-*'] });
    assert.strictEqual(checkCommand(['delete-bucket'], cfg).allowed, false);
    assert.strictEqual(checkCommand(['rm', 'something'], cfg).allowed, false);
    assert.strictEqual(checkCommand(['drop-table'], cfg).allowed, false);
    assert.strictEqual(checkCommand(['get-parameter'], cfg).allowed, true);
  });

  it('handles multiple allowed patterns', () => {
    const cfg = config({ allowedPatterns: ['get-*', 'list-*', 'describe-*'] });
    assert.strictEqual(checkCommand(['get-item'], cfg).allowed, true);
    assert.strictEqual(checkCommand(['list-buckets'], cfg).allowed, true);
    assert.strictEqual(checkCommand(['describe-instances'], cfg).allowed, true);
    assert.strictEqual(checkCommand(['delete-item'], cfg).allowed, false);
  });

  it('handles empty token array', () => {
    const result = checkCommand(
      [],
      config({ allowedPatterns: ['get-*'] })
    );
    assert.strictEqual(result.allowed, false);
  });

  it('blocks quoted blocked words after tokenization strips quotes', () => {
    const result = checkCommand(
      ['repo', 'delete', 'my-repo'],
      config({ blockedPatterns: ['repo delete'] })
    );
    assert.strictEqual(result.allowed, false);
  });

  it('blocks single quoted blocked word after tokenization', () => {
    const result = checkCommand(
      ['s3api', 'delete-bucket', '--bucket', 'test'],
      config({ blockedPatterns: ['delete-*'] })
    );
    assert.strictEqual(result.allowed, false);
  });

  it('blocks when blocked word appears as positional subcommand token', () => {
    const result = checkCommand(
      ['s3', 'ls', 'delete-object'],
      config({ blockedPatterns: ['delete-*'] })
    );
    assert.strictEqual(result.allowed, false);
  });

  it('does NOT match argument values against patterns', () => {
    const result = checkCommand(
      ['ssm', 'get-parameter', '--name', 'run-config'],
      config({ blockedPatterns: ['run-*'] })
    );
    assert.strictEqual(result.allowed, true);
  });

  it('does NOT allow via argument value matching allowed pattern', () => {
    const result = checkCommand(
      ['iam', 'attach-user-policy', '--policy-arn', 'list-something'],
      config({ allowedPatterns: ['list-*', 'get-*'] })
    );
    assert.strictEqual(result.allowed, false);
  });

  it('stops at first flag token for subcommand extraction', () => {
    const result = checkCommand(
      ['ec2', 'describe-instances', '--filter', 'Name=tag:delete-me'],
      config({ blockedPatterns: ['delete-*'] })
    );
    assert.strictEqual(result.allowed, true);
  });

  it('handles all-flags command (no subcommand tokens)', () => {
    const result = checkCommand(
      ['--version'],
      config({ blockedPatterns: ['delete-*'] })
    );
    assert.strictEqual(result.allowed, true);
  });

  it('handles all-flags command with allowed patterns', () => {
    const result = checkCommand(
      ['--version'],
      config({ allowedPatterns: ['get-*'] })
    );
    assert.strictEqual(result.allowed, false);
  });
});

describe('processTokens', () => {
  it('strips arg with following value', () => {
    const result = processTokens(
      ['ssm', 'get-parameter', '--profile', 'dev', '--name', '/foo'],
      config({ stripArgs: ['--profile'] })
    );
    assert.deepStrictEqual(result, ['ssm', 'get-parameter', '--name', '/foo']);
  });

  it('strips arg with = value syntax', () => {
    const result = processTokens(
      ['ssm', 'get-parameter', '--profile=dev', '--name', '/foo'],
      config({ stripArgs: ['--profile'] })
    );
    assert.deepStrictEqual(result, ['ssm', 'get-parameter', '--name', '/foo']);
  });

  it('prepends args to command', () => {
    const result = processTokens(
      ['ssm', 'get-parameter', '--name', '/foo'],
      config({ prependArgs: ['--output', 'json'] })
    );
    assert.deepStrictEqual(result, ['--output', 'json', 'ssm', 'get-parameter', '--name', '/foo']);
  });

  it('handles combined strip and prepend', () => {
    const result = processTokens(
      ['ssm', 'get-parameter', '--profile', 'dev', '--name', '/foo'],
      config({ stripArgs: ['--profile'], prependArgs: ['--output', 'json'] })
    );
    assert.deepStrictEqual(result, ['--output', 'json', 'ssm', 'get-parameter', '--name', '/foo']);
  });

  it('does not remove unrelated args', () => {
    const result = processTokens(
      ['ssm', 'get-parameter', '--name', '/foo', '--region', 'us-east-1'],
      config({ stripArgs: ['--profile'] })
    );
    assert.deepStrictEqual(result, ['ssm', 'get-parameter', '--name', '/foo', '--region', 'us-east-1']);
  });

  it('strips multiple different args', () => {
    const result = processTokens(
      ['ssm', 'get-parameter', '--profile', 'dev', '--endpoint-url', 'http://localhost', '--name', '/foo'],
      config({ stripArgs: ['--profile', '--endpoint-url'] })
    );
    assert.deepStrictEqual(result, ['ssm', 'get-parameter', '--name', '/foo']);
  });

  it('returns tokens unchanged when no processing needed', () => {
    const result = processTokens(
      ['ssm', 'get-parameter'],
      config()
    );
    assert.deepStrictEqual(result, ['ssm', 'get-parameter']);
  });

  it('handles strip when arg is at end of command', () => {
    const result = processTokens(
      ['ssm', 'get-parameter', '--profile', 'dev'],
      config({ stripArgs: ['--profile'] })
    );
    assert.deepStrictEqual(result, ['ssm', 'get-parameter']);
  });

  it('does not strip value that starts with dash (flag)', () => {
    const result = processTokens(
      ['cmd', '--strip', '--next-flag', 'value'],
      config({ stripArgs: ['--strip'] })
    );
    assert.deepStrictEqual(result, ['cmd', '--next-flag', 'value']);
  });

  it('does not strip partial flag matches', () => {
    const result = processTokens(
      ['cmd', '--profilex', 'staging', '--name', 'foo'],
      config({ stripArgs: ['--profile'] })
    );
    assert.deepStrictEqual(result, ['cmd', '--profilex', 'staging', '--name', 'foo']);
  });

  it('strips quoted arg names that bypass raw-string regex', () => {
    const result = processTokens(
      ['get-parameter', '--endpoint-url', 'http://evil.com', '--name', '/foo'],
      config({ stripArgs: ['--endpoint-url'] })
    );
    assert.deepStrictEqual(result, ['get-parameter', '--name', '/foo']);
  });

  it('handles flag at end with no value', () => {
    const result = processTokens(
      ['cmd', '--verbose', '--profile'],
      config({ stripArgs: ['--profile'] })
    );
    assert.deepStrictEqual(result, ['cmd', '--verbose']);
  });

  it('strips same flag appearing multiple times', () => {
    const result = processTokens(
      ['cmd', '--profile', 'dev', '--name', 'foo', '--profile', 'prod'],
      config({ stripArgs: ['--profile'] })
    );
    assert.deepStrictEqual(result, ['cmd', '--name', 'foo']);
  });

  it('handles empty token array', () => {
    const result = processTokens([], config({ stripArgs: ['--profile'] }));
    assert.deepStrictEqual(result, []);
  });

  it('handles empty stripArgs and prependArgs', () => {
    const result = processTokens(
      ['cmd', '--name', 'foo'],
      config()
    );
    assert.deepStrictEqual(result, ['cmd', '--name', 'foo']);
  });

  it('strips =value form with complex value', () => {
    const result = processTokens(
      ['cmd', '--endpoint-url=http://localhost:4566/path?q=1', '--name', 'foo'],
      config({ stripArgs: ['--endpoint-url'] })
    );
    assert.deepStrictEqual(result, ['cmd', '--name', 'foo']);
  });

  it('does not consume next flag as value', () => {
    const result = processTokens(
      ['cmd', '--profile', '--name', 'foo'],
      config({ stripArgs: ['--profile'] })
    );
    assert.deepStrictEqual(result, ['cmd', '--name', 'foo']);
  });

  it('strips only exact match, not substring of token', () => {
    const result = processTokens(
      ['cmd', '--profile', 'dev'],
      config({ stripArgs: ['--pro'] })
    );
    assert.deepStrictEqual(result, ['cmd', '--profile', 'dev']);
  });

  it('prepend works with empty input tokens', () => {
    const result = processTokens(
      [],
      config({ prependArgs: ['--output', 'json'] })
    );
    assert.deepStrictEqual(result, ['--output', 'json']);
  });
});

describe('formatOutput', () => {
  it('detects JSON object', () => {
    const result = formatOutput('{"key":"value"}', '');
    assert.deepStrictEqual(result, {
      type: 'json',
      data: { key: 'value' },
    });
  });

  it('detects JSON array', () => {
    const result = formatOutput('[1,2,3]', '');
    assert.deepStrictEqual(result, {
      type: 'json',
      data: [1, 2, 3],
    });
  });

  it('returns text for non-JSON output', () => {
    const result = formatOutput('some text', '');
    assert.deepStrictEqual(result, {
      type: 'text',
      output: 'some text',
    });
  });

  it('returns text for invalid JSON starting with {', () => {
    const result = formatOutput('{not json}', '');
    assert.strictEqual(result.type, 'text');
    assert.strictEqual(result.output, '{not json}');
    assert.strictEqual(result.data, undefined);
  });

  it('returns text for invalid JSON starting with [', () => {
    const result = formatOutput('[not json either', '');
    assert.strictEqual(result.type, 'text');
    assert.strictEqual(result.output, '[not json either');
  });

  it('returns text for empty string', () => {
    const result = formatOutput('', '');
    assert.deepStrictEqual(result, {
      type: 'text',
      output: '',
    });
  });

  it('includes stderr when present', () => {
    const result = formatOutput('output text', 'warning: something');
    assert.deepStrictEqual(result, {
      type: 'text',
      output: 'output text',
      stderr: 'warning: something',
    });
  });

  it('includes stderr with JSON output', () => {
    const result = formatOutput('{"key":"value"}', 'debug info');
    assert.deepStrictEqual(result, {
      type: 'json',
      data: { key: 'value' },
      stderr: 'debug info',
    });
  });

  it('omits stderr when empty', () => {
    const result = formatOutput('hello', '');
    assert.strictEqual(result.stderr, undefined);
  });

  it('omits stderr when only whitespace', () => {
    const result = formatOutput('hello', '   ');
    assert.strictEqual(result.stderr, undefined);
  });

  it('trims stdout before processing', () => {
    const result = formatOutput('  {"key":"value"}  ', '');
    assert.deepStrictEqual(result, {
      type: 'json',
      data: { key: 'value' },
    });
  });

  it('trims stderr output', () => {
    const result = formatOutput('text', '  warning  ');
    assert.strictEqual(result.stderr, 'warning');
  });

  it('handles nested JSON object', () => {
    const json = '{"outer":{"inner":"value"},"arr":[1,2]}';
    const result = formatOutput(json, '');
    assert.strictEqual(result.type, 'json');
    assert.deepStrictEqual(result.data, { outer: { inner: 'value' }, arr: [1, 2] });
  });

  it('handles JSON with whitespace formatting', () => {
    const json = `{
  "key": "value",
  "num": 42
}`;
    const result = formatOutput(json, '');
    assert.strictEqual(result.type, 'json');
    assert.deepStrictEqual(result.data, { key: 'value', num: 42 });
  });
});
