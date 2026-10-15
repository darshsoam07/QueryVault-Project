/** Local development boundary, not proof that a remote account is free. */
export function assertLoopbackHttpUrl(input: string | URL): void {
  const url = new URL(input);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error("Zero-cost local profile blocks non-loopback endpoints.");
  }
}

export function localOnlyFetch(delegate: typeof fetch): typeof fetch {
  return async (input, init) => {
    assertLoopbackHttpUrl(input instanceof Request ? input.url : input);
    // A local redirect must not send credentials to a hosted endpoint.
    return delegate(input, { ...init, redirect: "error" });
  };
}
