import { Context } from "effect";

export class CurrentRequest extends Context.Service<CurrentRequest, globalThis.Request>()("CurrentRequest") {}
