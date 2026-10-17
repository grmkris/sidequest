import { code as highlighter } from '@streamdown/code'
import rehypeSanitize from 'rehype-sanitize'
import { Streamdown } from 'streamdown'

const plugins = { code: highlighter }
const sanitizers = [rehypeSanitize]

export default function HighlightedCode({ code, language }: { code: string; language: string }) {
  // A longer fence prevents authored backticks from escaping the literal code block.
  const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/gu)].map((match) => match[0].length + 1)))
  return (
    <Streamdown mode="static" plugins={plugins} rehypePlugins={sanitizers} controls={false}>
      {`${fence}${language.replace(/[^a-zA-Z0-9_+-]/gu, '')}\n${code}\n${fence}`}
    </Streamdown>
  )
}
