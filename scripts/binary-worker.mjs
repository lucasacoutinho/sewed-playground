import * as Worker from "sewed/worker";
import { Protocol } from "./binary-contract.mjs";
import { handlers } from "./binary-handlers.mjs";
export default Worker.define(Protocol, handlers("worker"));
