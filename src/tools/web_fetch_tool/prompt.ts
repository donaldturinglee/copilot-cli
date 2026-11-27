export const WEB_FETCH_TOOL_DESCRIPTION =
  'Fetches content from a URL, converts HTML to Markdown, and summarizes/extracts information using the given prompt.'

export const WEB_FETCH_TOOL_PROMPT = `Fetches content from a specified URL and processes it using an AI model.
Usage:
- URL must be a valid HTTP or HTTPS URL (HTTP is upgraded to HTTPS for non-local hosts).
- HTML responses are converted to Markdown before processing.
- Same-host and www-equivalent redirects are followed automatically; cross-host redirects return the target URL so you can decide whether to fetch it.
- Results are cached for 15 minutes.`
