import type * as ShopifyApi from "@shopify/shopify-api";
import { Context } from "effect";

export class CurrentSession extends Context.Service<CurrentSession, ShopifyApi.Session>()(
  "CurrentSession",
) {}
