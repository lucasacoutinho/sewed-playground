import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Effect } from "effect";
import type { Scope } from "effect";
import { SewedError } from "sewed";

const page = (title: string, body: string) =>
  `<!doctype html><title>${title}</title><body style="font: 15px system-ui; margin: 16px; color: #1f2933">${body}</body>`;

const handle = (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (url.pathname === "/two") {
    response.end(page("Guest two", `<h1 id="guest-two">Guest two</h1><a href="/">back to one</a>`));
    return;
  }
  response.end(page("Guest one", `<h1 id="guest-one">Guest one</h1><a href="/two">go to two</a>`));
};

const originOf = (server: Server) => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://localhost:${port}`;
};

export const createGuestSite: Effect.Effect<{ readonly origin: string }, SewedError, Scope.Scope> =
  Effect.acquireRelease(
    Effect.callback<Server, SewedError>((resume) => {
      const server = createServer(handle);
      server.once("error", (cause) => {
        resume(
          Effect.fail(
            new SewedError({ code: "Native", message: "The guest site could not listen", cause }),
          ),
        );
      });
      server.listen(0, "localhost", () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.sync(() => {
        server.close();
      }),
  ).pipe(Effect.map((server) => ({ origin: originOf(server) })));
