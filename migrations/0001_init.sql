create table if not exists Session (
  id text primary key,
  shop text not null,
  state text not null,
  isOnline integer not null,
  scope text,
  expires integer,
  accessToken text,
  userId integer,
  firstName text,
  lastName text,
  email text,
  accountOwner integer,
  locale text,
  collaborator integer,
  emailVerified integer,
  refreshToken text,
  refreshTokenExpires integer
);

--> statement-breakpoint
create index if not exists SessionShopIndex on Session (shop);
