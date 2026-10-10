/** Permissions and the connection protocol are independent. Only an explicit
 * compatibility override selects SDK exec; every unpinned launch uses app-server. */
export function codexTransportFor(spec: { providerOptions: Record<string, unknown> }): "exec" | "app-server" {
  const transport = spec.providerOptions.codexTransport ?? "app-server";
  if (transport !== "exec" && transport !== "app-server") throw new Error("codexTransport must be exec or app-server");
  return transport;
}
