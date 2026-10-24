import { describe, expect, it } from 'vitest'
import { normalizeAriaPaths } from './aria-normalize.ts'

describe('portable ARIA paths', () => {
  it('normalizes JSON-escaped Windows homes and their remaining path segments', () => {
    const home = String.raw`C:\Users\员工\AppData\Local\Temp\dsh-test\.dsh-home`
    const source = `- status: ${JSON.stringify(`reason: cannot resolve from ${home}\\profiles\\scaffold; run 'dsh plugin'`)}`
    expect(normalizeAriaPaths(source, String.raw`C:\Users\员工\AppData\Local\Temp\dsh-test`, [[home, '{{home}}']]))
      .toBe('- status: "reason: cannot resolve from {{home}}/profiles/scaffold; run \'dsh plugin\'"')
  })

  it('normalizes Windows workspace headings and plain file paths', () => {
    const root = String.raw`C:\Temp\dsh-test`
    const source = `- heading "dsh-test"\n- text: ${root}\\src\\员工.ts`
    expect(normalizeAriaPaths(source, root)).toBe('- heading "{{workspace}}"\n- text: {{cwd}}/src/员工.ts')
  })

  it('handles forward-slash Windows paths and drive-letter casing', () => {
    expect(normalizeAriaPaths('- text: c:/Temp/dsh-test/src/a.ts', String.raw`C:\Temp\dsh-test`))
      .toBe('- text: {{cwd}}/src/a.ts')
  })

  it('keeps POSIX snapshots compatible', () => {
    expect(normalizeAriaPaths('- heading "dsh-test"\n- text: /tmp/dsh-test/src/a.ts', '/tmp/dsh-test'))
      .toBe('- heading "{{workspace}}"\n- text: {{cwd}}/src/a.ts')
  })

  it('normalizes quoted child paths with spaces without changing adjacent prose', () => {
    const root = String.raw`C:\Temp\dsh-test`
    const source = `- status: ${JSON.stringify(`open '${root}\\files\\a b.txt'; retry`)}`
    expect(normalizeAriaPaths(source, root)).toBe('- status: "open \'{{cwd}}/files/a b.txt\'; retry"')
  })

  it('preserves unrelated regular expressions and other roots', () => {
    const source = `- code: ${JSON.stringify(String.raw`\d+\w+`)}\n- text: C:\\Temp\\dsh-test-other\\a.ts`
    expect(normalizeAriaPaths(source, String.raw`C:\Temp\dsh-test`)).toBe(source)
  })

  it('does not replace workspace names inside existing snapshot tokens', () => {
    expect(normalizeAriaPaths('- text: /tmp/cwd/a.ts {{cwd}}', '/tmp/cwd')).toBe('- text: {{cwd}}/a.ts {{cwd}}')
  })

  it('applies scenario text replacements once and ignores empty values', () => {
    expect(normalizeAriaPaths('- text: provider', '/tmp/dsh-test', [['provider', '{{provider}}'], ['', 'ignored']]))
      .toBe('- text: {{provider}}')
  })
})
