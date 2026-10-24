export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '')

export async function apiRequest(path, options = {}) {
  let response
  try {
    response = await fetch(`${apiBaseUrl}/api${path}`, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    })
  } catch (error) {
    const cause = error instanceof Error ? error.message : 'No response was received.'
    throw new ApiError(`EcoPulse API returned no readable response. Check the deployed API URL, the backend CORS_ORIGIN allowlist, and network access (${cause}).`, 0)
  }
  let data
  try { data = await response.json() } catch { data = null }
  if (!response.ok) throw new ApiError(data?.error || `API request failed (${response.status}).`, response.status)
  return data
}

export const apiGet = path => apiRequest(path)
export const apiPost = (path, body = {}) => apiRequest(path, { method: 'POST', body })
