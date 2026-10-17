import { commonsHtml } from './generated/commons-app.ts'

export const COMMONS_UI_URI = 'ui://sidequest/commons/v1.html'
export const commonsResource = {
  uri: COMMONS_UI_URI,
  mimeType: 'text/html;profile=mcp-app',
  text: commonsHtml,
  _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } },
}
export const commonsUiMetadata = { ui: { resourceUri: COMMONS_UI_URI }, 'openai/outputTemplate': COMMONS_UI_URI }
