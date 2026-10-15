// Answers to Claude's questions, worded the one way Claude reads them, whichever app (or the
// Telegram bot, or a text command) collected them.

/** Your answer to one question: the options you picked (by position), or what you typed. */
export type QuestionAnswer = { picks: number[] } | { text: string }

interface AnsweredQuestion {
  question: string
  options?: { label: string }[]
}

/** "question" → label, label; "question" → what you typed. Unanswered ones are left out. */
export function describeAnswers(questions: AnsweredQuestion[], answers: (QuestionAnswer | undefined)[]): string {
  return questions
    .flatMap((q, i) => {
      const a = answers[i]
      if (!a) return []
      const value = 'text' in a ? a.text : a.picks.map(p => q.options?.[p]?.label ?? '?').join(', ')
      return [`"${q.question}" → ${value}`]
    })
    .join('; ')
}
