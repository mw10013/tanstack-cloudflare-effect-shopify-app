import { Context } from "effect";

export const Request = Context.Service<globalThis.Request>("Request");
