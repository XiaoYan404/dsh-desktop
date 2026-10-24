/** Bundled office automation instructions use the existing native skill and workflow execution services. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillDefinition, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

const skillNames = ['office-minutes', 'office-daily-report', 'office-expense-check', 'office-task-reminder'] as const

/** Private child-plugin identity under the opt-in native office tools. */
export const name = 'office-automation-skills'
/** Instructions become discoverable only in a composition containing the native skill registry. */
export const inject = ['skills']

/**
 * Register bundled office skills without changing tools, policy or existing skill precedence.
 * @param ctx - Office plugin scope owning the reversible provider contribution.
 */
export function apply(ctx: Context): void {
  const definitions = new Map<string, SkillDefinition>()
  const candidates: SkillCandidate[] = skillNames.map((skillName) => {
    const resourceUrl = new URL(`../assets/${skillName}/`, import.meta.url)
    const directory = fileURLToPath(resourceUrl)
    const path = fileURLToPath(new URL('SKILL.md', resourceUrl))
    const raw = readFileSync(path, 'utf8')
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
    if (frontmatter?.[1] === undefined) throw new Error(`${skillName}: missing YAML frontmatter`)
    const metadata: unknown = parseYaml(frontmatter[1])
    if (typeof metadata !== 'object' || metadata === null || !('name' in metadata) || metadata.name !== skillName ||
      !('description' in metadata) || typeof metadata.description !== 'string' || !metadata.description.trim()) {
      throw new Error(`${skillName}: expected its name and a nonempty description`)
    }
    const definition: SkillDefinition = {
      name: skillName, description: metadata.description, path,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-office-automation', source: 'bundled',
      resourceBase: { kind: 'directory', path: directory }, content: raw.slice(frontmatter[0].length).trim(),
    }
    definitions.set(skillName, definition)
    const { content: _content, ...summary } = definition
    return { ...summary, rank: BUNDLED_SKILL_RANK, locator: path }
  })
  const provider: SkillProvider = {
    name: 'dsh-office-automation',
    list: () => Promise.resolve(candidates),
    get: candidate => Promise.resolve(definitions.get(candidate.name)),
  }
  ctx.skills.registerProvider(() => provider)
}
