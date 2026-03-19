import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeCommand } from '../tokenizer.js';

describe('tokenizeCommand', () => {
  // ── Basic tokenization ───────────────────────────────────────────────

  describe('basic tokenization', () => {
    it('splits simple arguments', () => {
      assert.deepStrictEqual(
        tokenizeCommand('ssm get-parameter --name /foo'),
        ['ssm', 'get-parameter', '--name', '/foo']
      );
    });

    it('collapses multiple spaces between tokens', () => {
      assert.deepStrictEqual(
        tokenizeCommand('s3  ls   --recursive'),
        ['s3', 'ls', '--recursive']
      );
    });

    it('trims leading and trailing spaces', () => {
      assert.deepStrictEqual(
        tokenizeCommand('  s3 ls  '),
        ['s3', 'ls']
      );
    });

    it('returns empty array for empty string', () => {
      assert.deepStrictEqual(tokenizeCommand(''), []);
    });

    it('returns single-element array for single token', () => {
      assert.deepStrictEqual(tokenizeCommand('--version'), ['--version']);
    });

    it('handles tabs as whitespace', () => {
      assert.deepStrictEqual(
        tokenizeCommand('s3\tls'),
        ['s3', 'ls']
      );
    });
  });

  // ── Quoted strings ───────────────────────────────────────────────────

  describe('quoted strings', () => {
    it('strips double quotes and preserves inner content', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--filter "Name=tag:env"'),
        ['--filter', 'Name=tag:env']
      );
    });

    it('strips single quotes and preserves inner content', () => {
      assert.deepStrictEqual(
        tokenizeCommand("--filter 'Name=tag:env'"),
        ['--filter', 'Name=tag:env']
      );
    });

    it('preserves spaces inside double quotes', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--query "Reservations[*].Instances[*]"'),
        ['--query', 'Reservations[*].Instances[*]']
      );
    });

    it('empty double quotes produce no token (empty string not pushed)', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--tag ""'),
        ['--tag']
      );
    });

    it('empty single quotes produce no token (empty string not pushed)', () => {
      assert.deepStrictEqual(
        tokenizeCommand("--tag ''"),
        ['--tag']
      );
    });

    it('allows metacharacters inside double quotes', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--filter "key|value"'),
        ['--filter', 'key|value']
      );
    });

    it('allows pipe inside double quotes', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--jq ".[].name | length"'),
        ['--jq', '.[].name | length']
      );
    });

    it('allows semicolon inside double quotes', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--query "a;b"'),
        ['--query', 'a;b']
      );
    });

    it('allows ampersand inside double quotes', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--filter "a&b"'),
        ['--filter', 'a&b']
      );
    });

    it('allows dollar-paren inside double quotes', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--val "$(foo)"'),
        ['--val', '$(foo)']
      );
    });

    it('allows backtick inside double quotes', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--val "`foo`"'),
        ['--val', '`foo`']
      );
    });

    it('allows redirect chars inside double quotes', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--val "a > b < c"'),
        ['--val', 'a > b < c']
      );
    });

    it('allows metacharacters inside single quotes', () => {
      assert.deepStrictEqual(
        tokenizeCommand("--filter 'key|value;more&other'"),
        ['--filter', 'key|value;more&other']
      );
    });

    it('handles adjacent quoted and unquoted text', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--prefix="hello world"'),
        ['--prefix=hello world']
      );
    });
  });

  // ── Escape handling in double quotes ─────────────────────────────────

  describe('escape handling in double quotes', () => {
    it('handles escaped double quote inside double quotes', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--msg "say \\"hello\\""'),
        ['--msg', 'say "hello"']
      );
    });

    it('handles escaped backslash inside double quotes', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--path "C:\\\\Users"'),
        ['--path', 'C:\\Users']
      );
    });

    it('handles escaped backslash followed by text', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--path "C:\\\\Users\\\\foo"'),
        ['--path', 'C:\\Users\\foo']
      );
    });

    it('handles escape of non-special character inside double quotes', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--val "\\a"'),
        ['--val', 'a']
      );
    });
  });

  // ── Windows paths (cross-platform) ──────────────────────────────────

  describe('Windows paths', () => {
    it('preserves unquoted backslashes as literals', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--config C:\\Users\\foo'),
        ['--config', 'C:\\Users\\foo']
      );
    });

    it('preserves multiple backslash segments', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--dir D:\\Projects\\test\\output'),
        ['--dir', 'D:\\Projects\\test\\output']
      );
    });

    it('preserves backslash at end of token', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--dir C:\\Users\\'),
        ['--dir', 'C:\\Users\\']
      );
    });
  });

  // ── Shell metacharacter REJECTION ────────────────────────────────────

  describe('shell metacharacter rejection', () => {
    it('rejects semicolons', () => {
      assert.throws(
        () => tokenizeCommand('hello; cat /etc/passwd'),
        { message: /Shell metacharacter rejected.*';'/ }
      );
    });

    it('rejects pipe', () => {
      assert.throws(
        () => tokenizeCommand('hello | cat /etc/passwd'),
        { message: /Shell metacharacter rejected.*'\|'/ }
      );
    });

    it('rejects ampersand', () => {
      assert.throws(
        () => tokenizeCommand('hello & cat /etc/passwd'),
        { message: /Shell metacharacter rejected.*'&'/ }
      );
    });

    it('rejects double ampersand', () => {
      assert.throws(
        () => tokenizeCommand('hello && cat /etc/passwd'),
        { message: /Shell metacharacter rejected.*'&'/ }
      );
    });

    it('rejects command substitution $(...)', () => {
      assert.throws(
        () => tokenizeCommand('hello $(cat /etc/passwd)'),
        { message: /Shell metacharacter rejected/ }
      );
    });

    it('rejects backtick', () => {
      assert.throws(
        () => tokenizeCommand('hello `cat /etc/passwd`'),
        { message: /Shell metacharacter rejected.*'`'/ }
      );
    });

    it('rejects redirect out >', () => {
      assert.throws(
        () => tokenizeCommand('hello > /tmp/pwned'),
        { message: /Shell metacharacter rejected.*'>'/ }
      );
    });

    it('rejects redirect in <', () => {
      assert.throws(
        () => tokenizeCommand('hello < /etc/passwd'),
        { message: /Shell metacharacter rejected.*'<'/ }
      );
    });

    it('rejects variable expansion ${...}', () => {
      assert.throws(
        () => tokenizeCommand('hello ${HOME}'),
        { message: /Shell metacharacter rejected/ }
      );
    });

    it('rejects newline', () => {
      assert.throws(
        () => tokenizeCommand('hello\ncat /etc/passwd'),
        { message: /Shell metacharacter rejected.*newline/ }
      );
    });

    it('rejects carriage return', () => {
      assert.throws(
        () => tokenizeCommand('hello\rcat /etc/passwd'),
        { message: /Shell metacharacter rejected.*newline/ }
      );
    });

    it('rejects metacharacter at start of command', () => {
      assert.throws(
        () => tokenizeCommand(';whoami'),
        { message: /Shell metacharacter rejected/ }
      );
    });

    it('rejects metacharacter at end of command', () => {
      assert.throws(
        () => tokenizeCommand('whoami;'),
        { message: /Shell metacharacter rejected/ }
      );
    });

    it('rejects append redirect >>', () => {
      assert.throws(
        () => tokenizeCommand('hello >> /tmp/pwned'),
        { message: /Shell metacharacter rejected.*'>'/ }
      );
    });

    it('rejects pipe to specific command', () => {
      assert.throws(
        () => tokenizeCommand('ls |grep secret'),
        { message: /Shell metacharacter rejected.*'\|'/ }
      );
    });
  });

  // ── Error cases ──────────────────────────────────────────────────────

  describe('error cases', () => {
    it('throws on unterminated single quote', () => {
      assert.throws(
        () => tokenizeCommand("--name 'unterminated"),
        { message: /Unterminated single quote/ }
      );
    });

    it('throws on unterminated double quote', () => {
      assert.throws(
        () => tokenizeCommand('--name "unterminated'),
        { message: /Unterminated double quote/ }
      );
    });

    it('throws on unterminated single quote at end', () => {
      assert.throws(
        () => tokenizeCommand("hello '"),
        { message: /Unterminated single quote/ }
      );
    });

    it('throws on unterminated double quote at end', () => {
      assert.throws(
        () => tokenizeCommand('hello "'),
        { message: /Unterminated double quote/ }
      );
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles only whitespace', () => {
      assert.deepStrictEqual(tokenizeCommand('   '), []);
    });

    it('handles mixed single and double quotes in one command', () => {
      assert.deepStrictEqual(
        tokenizeCommand(`--a "hello world" --b 'foo bar'`),
        ['--a', 'hello world', '--b', 'foo bar']
      );
    });

    it('handles equals sign without quoting', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--key=value'),
        ['--key=value']
      );
    });

    it('handles multiple consecutive quoted args', () => {
      assert.deepStrictEqual(
        tokenizeCommand('"first" "second" "third"'),
        ['first', 'second', 'third']
      );
    });

    it('handles single character tokens', () => {
      assert.deepStrictEqual(
        tokenizeCommand('a b c'),
        ['a', 'b', 'c']
      );
    });

    it('handles forward slash paths (Unix)', () => {
      assert.deepStrictEqual(
        tokenizeCommand('--config /etc/app/config.json'),
        ['--config', '/etc/app/config.json']
      );
    });
  });
});
