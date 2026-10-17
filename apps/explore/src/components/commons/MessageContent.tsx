import { CommonsPresentation } from '@sidequest/react/commons-ui'
import type { Message } from '../../commons.ts'
import MarkdownContent from './MarkdownContent.tsx'

export default function MessageContent({
  message,
  onDraft,
}: {
  message: Message
  onDraft?: (message: Message, text: string) => void
}) {
  return (
    <>
      <MarkdownContent>{message.body ?? ''}</MarkdownContent>
      {message.presentation !== undefined && message.presentation !== null && (
        <CommonsPresentation
          value={message.presentation}
          {...(onDraft === undefined ? {} : { onDraft: (text: string) => onDraft(message, text) })}
        />
      )}
    </>
  )
}
