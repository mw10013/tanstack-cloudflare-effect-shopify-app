import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { D1 } from "@/lib/D1";
import { KV } from "@/lib/KV";

const TodoInput = Schema.Struct({
  title: Schema.String,
});

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
}

const selectTodosSql = `
select
  json_group_array(
    json_object(
      'id', id,
      'title', title,
      'createdAt', createdAt
    )
  ) as todos
from (
  select id, title, createdAt
  from Todo
  order by createdAt desc
)
`;

const ensureTodoTableSql = `
create table if not exists Todo (
  id text primary key,
  title text not null,
  createdAt text not null
)
`;

export const getIndexData = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const d1 = yield* D1;
        const kv = yield* KV;
        yield* d1.run(d1.prepare(ensureTodoTableSql), { idempotentWrite: true });
        const row = yield* d1.first<{ todos: string | null }>(
          d1.prepare(selectTodosSql),
        );
        const todosJson = row.pipe(
          Option.match({
            onNone: () => null,
            onSome: (value) => value.todos,
          }),
        );
        const todos = todosJson ? ((JSON.parse(todosJson) as Todo[]) ?? []) : [];
        const lastCreatedAt = yield* kv.get("todo:lastCreatedAt");
        return {
          todos,
          lastCreatedAt: lastCreatedAt ?? "never",
        };
      }),
    ),
);

export const createTodo = createServerFn({ method: "POST" })
  .inputValidator(Schema.toStandardSchemaV1(TodoInput))
  .handler(({ data, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const title = data.title.trim();
        if (!title) return yield* Effect.fail(new Error("title is required"));
        const d1 = yield* D1;
        const kv = yield* KV;
        yield* d1.run(d1.prepare(ensureTodoTableSql), { idempotentWrite: true });
        const id = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        yield* d1.run(
          d1
            .prepare("insert into Todo (id, title, createdAt) values (?1, ?2, ?3)")
            .bind(id, title, createdAt),
          { idempotentWrite: true },
        );
        yield* kv.put("todo:lastCreatedAt", createdAt);
        return { id, title, createdAt };
      }),
    ),
  );

export const Route = createFileRoute("/")({
  loader: () => getIndexData(),
  component: RouteComponent,
});

function RouteComponent() {
  const { todos, lastCreatedAt } = Route.useLoaderData();
  const router = useRouter();
  const createTodoServerFn = useServerFn(createTodo);
  const mutation = useMutation({
    mutationFn: (data: typeof TodoInput.Type) => createTodoServerFn({ data }),
    onSuccess: () =>
      void router.invalidate({
        filter: (match) => match.routeId === Route.id,
      }),
  });
  const form = useForm({
    defaultValues: {
      title: "",
    } satisfies typeof TodoInput.Type,
    validators: {
      onSubmit: Schema.toStandardSchemaV1(TodoInput),
    },
    onSubmit: ({ value }) => {
      void mutation.mutateAsync(value);
    },
  });

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">tanstack-cloudflare-effect-shopify-app</h1>
        <p className="text-sm text-muted-foreground">
          Server functions + TanStack Form + useMutation + Effect v4 + D1 + KV
        </p>
      </header>

      <section className="rounded-lg border p-4">
        <form
          id="todo-form"
          className="flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="title">
            {(field) => (
              <input
                className="h-10 flex-1 rounded-md border px-3"
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => {
                  field.handleChange(event.target.value);
                }}
                placeholder="Add todo"
              />
            )}
          </form.Field>
          <button
            type="submit"
            className="h-10 rounded-md border px-4"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Saving..." : "Add"}
          </button>
        </form>
        {mutation.error ? (
          <p className="mt-2 text-sm text-red-600">{mutation.error.message}</p>
        ) : null}
      </section>

      <section className="rounded-lg border p-4">
        <p className="text-sm text-muted-foreground">
          Last KV write: {lastCreatedAt}
        </p>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="mb-3 text-lg font-medium">Todos</h2>
        {todos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No todos yet.</p>
        ) : (
          <ul className="space-y-2">
            {todos.map((todo) => (
              <li key={todo.id} className="rounded-md border p-3">
                <p className="font-medium">{todo.title}</p>
                <p className="text-xs text-muted-foreground">{todo.createdAt}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
