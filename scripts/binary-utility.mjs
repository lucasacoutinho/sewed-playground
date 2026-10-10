import * as Utility from "sewed/utility";
import { Protocol } from "./binary-contract.mjs";
import { handlers } from "./binary-handlers.mjs";
export default Utility.define(Protocol, handlers("utility"));
