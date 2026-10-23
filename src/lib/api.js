export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function apiRequest(path, options = {}) {
  let response
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    })
  } catch {
    throw new ApiError('EcoPulse API is unreachable. Start the backend to persist dispatch data.', 0)
  }
  let data
  try { data = await response.json() } catch { data = null }
  if (!response.ok) throw new ApiError(data?.error || `API request failed (${response.status}).`, response.status)
  return data
}

export const apiGet = path => apiRequest(path)
export const apiPost = (path, body = {}) => apiRequest(path, { method: 'POST', body })
