export type SideQuestionRequest = {
  question: string
  ephemeral: true
}

export function parseSideQuestion(args: string): SideQuestionRequest | null {
  const question = args.trim()
  if (!question) return null
  return { question, ephemeral: true }
}

export function formatSideQuestionResponse(
  question: string,
  answer: string,
): string {
  return `[btw] Q: ${question}\n${answer.trim()}`
}
