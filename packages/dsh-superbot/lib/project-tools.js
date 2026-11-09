/**
 * Read-only project tools: list DSH workspaces and match a requirement to them.
 * The host workspaceRegistry is authoritative; no workspace is created here.
 */

import { matchRequirement, readProjects } from './workspace-service.js'

const textRender = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
const objectOutput = { schema: { type: 'object', additionalProperties: true }, render: textRender }

/** @param {import('@deepseek-ai/cordis').Context} ctx @param {{getConfig?: () => Record<string, unknown>}} [options] */
export function createProjectTools(ctx, { getConfig } = {}) {
  const enabledOrThrow = () => {
    if (getConfig?.()?.toolsEnabled === false) throw new Error('superbot task tools are disabled in settings')
  }
  return [
    {
      name: 'superbot_project_list',
      description: 'List DSH workspaces as the current project inventory (read-only; DSH workspaceRegistry is authoritative).',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: objectOutput,
      execute() {
        enabledOrThrow()
        return readProjects(ctx)
      },
    },
    {
      name: 'superbot_project_match',
      description: 'Match a requirement to existing DSH workspaces. Returns ranked candidates and needsConfirmation; never creates a project.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['text'],
        properties: { text: { type: 'string', description: 'The user requirement, verbatim.' } },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow()
        const text = String(args.text ?? '').trim()
        if (text === '') throw new Error('text is required')
        const inventory = readProjects(ctx)
        return { source: inventory.source, ...matchRequirement(text, inventory.projects) }
      },
    },
  ]
}
