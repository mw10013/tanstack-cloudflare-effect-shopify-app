import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: ({ location }) => {
    if (location.searchStr.includes("shop=")) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ href: `/app${location.searchStr}` });
    }
  },
  component: IndexPage,
});

function IndexPage() {
  return (
    <div style={{ fontFamily: "Inter, system-ui, sans-serif", margin: 0, padding: "2rem", background: "#f4f4f5", color: "#18181b", minHeight: "100vh" }}>
      <div style={{ maxWidth: "34rem", margin: "0 auto", background: "#fff", border: "1px solid #e4e4e7", borderRadius: "0.75rem", padding: "1.25rem" }}>
        <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.25rem" }}>Log in</h1>
        <p style={{ margin: "0 0 1rem", color: "#52525b" }}>Enter your shop domain to install or log in.</p>
        <form method="post" action="/auth/login">
          <label htmlFor="shop" style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.4rem" }}>Shop domain</label>
          <input id="shop" name="shop" placeholder="my-shop.myshopify.com" required style={{ width: "100%", boxSizing: "border-box" as const, padding: "0.625rem 0.75rem", border: "1px solid #d4d4d8", borderRadius: "0.5rem", font: "inherit" }} />
          <button type="submit" style={{ marginTop: "0.75rem", padding: "0.625rem 0.875rem", border: "1px solid #18181b", background: "#18181b", color: "#fff", borderRadius: "0.5rem", font: "inherit", cursor: "pointer" }}>Log in</button>
        </form>
      </div>
    </div>
  );
}
