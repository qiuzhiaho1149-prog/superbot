/**
 * Pure context policies for dsh-superbot.
 * No host imports: unit-testable with `node --test`.
 */

/**
 * Retain reasoning blocks only in the most recent `keep` assistant messages.
 * Older reasoning blocks are removed; text/tool-call blocks stay untouched.
 * @param {ReadonlyArray<Record<string, unknown>>} messages provider-neutral messages
 * @param {number} keep assistant messages whose reasoning survives
 * @returns {{messages: Array<Record<string, unknown>>, removedBlocks: number, removedChars: number, keptMessages: number}}
 */
export function retainRecentReasoning(messages, keep = 2) {
  const limit = Number.isInteger(keep) && keep >= 0 ? keep : 0
  const assistantReasoning = []
  const list = Array.isArray(messages) ? messages : []

  for (let index = 0; index < list.length; index += 1) {
    const message = list[index]
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    if (message.content.some((block) => block?.type === 'reasoning')) assistantReasoning.push(index)
  }

  if (assistantReasoning.length <= limit) {
    return { messages: list, removedBlocks: 0, removedChars: 0, keptMessages: assistantReasoning.length }
  }

  const keepIndexes = new Set(limit === 0 ? [] : assistantReasoning.slice(-limit))
  let removedBlocks = 0
  let removedChars = 0
  const out = list.map((message, index) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return message
    if (keepIndexes.has(index)) return message
    let changed = false
    const content = []
    for (const block of message.content) {
      if (block?.type === 'reasoning') {
        changed = true
        removedBlocks += 1
        removedChars += typeof block.text === 'string' ? block.text.length : 0
      } else {
        content.push(block)
      }
    }
    return changed ? { ...message, content } : message
  })

  return { messages: out, removedBlocks, removedChars, keptMessages: keepIndexes.size }
}

/**
 * Canonical text for duplicate detection: only text blocks participate.
 * @param {ReadonlyArray<{type?: string, text?: string}>} content
 * @returns {string}
 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
}

/**
 * Whether a tool result may be deduplicated without losing non-text payloads.
 * @param {ReadonlyArray<{type?: string}>} content
 * @returns {boolean}
 */
export function isPlainTextContent(content) {
  return Array.isArray(content) && content.length > 0 && content.every((block) => block?.type === 'text')
}

/**
 * The visible replacement for an omitted duplicate. Keeps a readable recovery path.
 * @param {string} storedPath absolute path to the stored original
 * @returns {string}
 */
export function duplicateNotice(storedPath) {
  return `[duplicate tool result omitted; identical output stored at ${storedPath}; use read or grep on that path if needed]`
}
