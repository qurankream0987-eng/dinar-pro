/** A deliberate, user-safe Whop refusal: the message and code survive the API error boundary. */
export function whopRefusal(
  status: number,
  message: string,
  code: string,
): Error & { status: number; code: string; expose: true } {
  return Object.assign(new Error(message), {
    status,
    code,
    expose: true as const,
  });
}
