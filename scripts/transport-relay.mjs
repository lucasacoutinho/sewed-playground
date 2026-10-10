import { Effect, Stream } from "effect";
import * as Worker from "sewed/worker";
import { Direct, Echo } from "./transport-contract.mjs";

export default Worker.define(
  Echo,
  Echo.toLayer(
    Effect.gen(function* () {
      const client = yield* Direct();
      const thread = yield* Worker.threadId;
      const record = (value) => ({ ...value, via: [...value.via, thread] });
      return {
        echo: (payload) => client.echo(payload).pipe(Effect.map(record)),
        repeat: (payload) => client.repeat(payload).pipe(Stream.map(record)),
        produce: (payload) => client.produce(payload).pipe(Stream.map(record)),
      };
    }),
  ),
  { bindings: [Direct] },
);
