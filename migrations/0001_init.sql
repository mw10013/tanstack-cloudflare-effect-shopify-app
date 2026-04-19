create table if not exists ShopifySession (
  id text primary key,
  shop text not null,
  payload text not null,
  createdAt text not null default (datetime('now')),
  updatedAt text not null default (datetime('now'))
);

--> statement-breakpoint
create index if not exists ShopifySessionShopIndex on ShopifySession (shop);
